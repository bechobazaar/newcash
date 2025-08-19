// get-order.js — Netlify Function (no fetch, uses https)
// - Reads a Cashfree order by ID and returns its status + tags for resume
// - Clean CORS with single Access-Control-Allow-Origin value

const https = require("https");

const ENV = process.env.CASHFREE_ENV === "sandbox" ? "sandbox" : "production";
const CF_HOST = ENV === "sandbox" ? "sandbox.cashfree.com" : "api.cashfree.com";
const CF_APP_ID = process.env.CASHFREE_APP_ID || "";
const CF_SECRET = process.env.CASHFREE_SECRET_KEY || "";
const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

function pickOrigin(event) {
  const reqOrigin =
    event.headers?.origin ||
    event.headers?.Origin ||
    event.headers?.ORIGIN ||
    "";
  if (ALLOWED.includes(reqOrigin)) return reqOrigin;
  return ALLOWED[0] || "";
}

function corsHeaders(event) {
  const allowOrigin = pickOrigin(event);
  const base = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
  if (allowOrigin) base["Access-Control-Allow-Origin"] = allowOrigin;
  return base;
}

function ok(body, event) {
  return {
    statusCode: 200,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
  };
}

function bad(status, msg, event) {
  return {
    statusCode: status,
    headers: corsHeaders(event),
    body: JSON.stringify({ error: msg }),
  };
}

function httpsJSON({ host, path, method = "GET", headers = {} }) {
  const opts = {
    host,
    path,
    method,
    headers: {
      "Content-Type": "application/json",
      "x-api-version": "2022-09-01",
      ...headers,
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            const err = new Error(
              `CF GET ${path} ${res.statusCode}: ${data}`
            );
            err.statusCode = res.statusCode;
            err.body = json;
            reject(err);
          }
        } catch (e) {
          e.message = `CF parse error: ${e.message} :: ${data}`;
          reject(e);
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(event), body: "" };
  }

  if (event.httpMethod !== "GET") {
    return bad(405, "Method Not Allowed", event);
  }

  if (!CF_APP_ID || !CF_SECRET) {
    return bad(500, "Cashfree credentials missing on server", event);
  }

  const orderId = event.queryStringParameters?.order_id;
  if (!orderId) return bad(400, "order_id is required", event);

  try {
    const json = await httpsJSON({
      host: CF_HOST,
      path: `/pg/orders/${encodeURIComponent(orderId)}`,
      method: "GET",
      headers: {
        "x-client-id": CF_APP_ID,
        "x-client-secret": CF_SECRET,
      },
    });

    // Return only the useful bits to the client
    const resp = {
      order_id: json.order_id,
      order_status: json.order_status,
      cf_order_id: json.cf_order_id,
      order_amount: json.order_amount,
      order_currency: json.order_currency,
      order_tags: json.order_tags || {},
      payments: json.payments || undefined, // optional; remove if you want a smaller response
    };

    return ok(resp, event);
  } catch (e) {
    const status = e.statusCode || 500;
    const message =
      e.body?.message ||
      e.message ||
      "Failed to fetch order from Cashfree";
    return bad(status, message, event);
  }
};
