// create-order.js — Netlify Function (no fetch, uses https)
// - Creates Cashfree order and returns { order_id, payment_session_id, ... }
// - CORS: returns a single Access-Control-Allow-Origin based on allowlist
// - No user email/phone required on client. We send safe placeholders here.

const https = require("https");

// ====== ENV ======
const ENV = process.env.CASHFREE_ENV === "sandbox" ? "sandbox" : "production";
const CF_HOST = ENV === "sandbox" ? "sandbox.cashfree.com" : "api.cashfree.com";
const CF_ORDERS_PATH = "/pg/orders";
const CF_APP_ID = process.env.CASHFREE_APP_ID || "";
const CF_SECRET = process.env.CASHFREE_SECRET_KEY || "";
const RETURN_URL =
  process.env.RETURN_URL ||
  "https://www.bechobazaar.com/account.html?cf=true&order_id={order_id}";
const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ====== CORS helpers ======
function pickOrigin(event) {
  const reqOrigin =
    event.headers?.origin ||
    event.headers?.Origin ||
    event.headers?.ORIGIN ||
    "";
  if (ALLOWED.includes(reqOrigin)) return reqOrigin;
  // no matching origin, return first allowlisted (or empty to omit)
  return ALLOWED[0] || "";
}

function corsHeaders(event) {
  const allowOrigin = pickOrigin(event);
  const base = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
  if (allowOrigin) base["Access-Control-Allow-Origin"] = allowOrigin; // single value only
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

// ====== tiny https client ======
function httpsJSON({ host, path, method = "GET", headers = {}, bodyObj }) {
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : null;

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
  if (bodyStr) {
    opts.headers["Content-Length"] = Buffer.byteLength(bodyStr);
  }

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
              `CF ${method} ${path} ${res.statusCode}: ${data}`
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
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ====== util ======
function genOrderId(prefix = "bb") {
  // unique-ish: bb_<timestamp>_<rand4>
  const r = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${Date.now()}_${r}`;
}

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(event), body: "" };
  }

  if (event.httpMethod !== "POST") {
    return bad(405, "Method Not Allowed", event);
  }

  // Check Cashfree creds
  if (!CF_APP_ID || !CF_SECRET) {
    return bad(500, "Cashfree credentials missing on server", event);
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (_) {
    return bad(400, "Invalid JSON", event);
  }

  // Read client inputs (no email/phone required from user)
  const amount = Number(payload.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return bad(400, "amount must be a positive number", event);
  }

  const currency = (payload.currency || "INR").toUpperCase();
  const purpose = String(payload.purpose || "");
  const adId = payload.adId ? String(payload.adId) : "";

  // We prefer a stable customer_id (uid) when available
  const customer = payload.customer || {};
  const customerId = String(customer.id || "guest");

  // server-side safe placeholders so user does NOT need to enter details
  const customerEmail = "guest@bechobazaar.com";
  const customerPhone = "9999999999";

  // generate our own order_id (recommended)
  const orderId = genOrderId("bb");

  // Build CF order body
  const cfBody = {
    order_id: orderId,
    order_amount: amount,
    order_currency: currency,
    customer_details: {
      customer_id: customerId,
      customer_email: customerEmail,
      customer_phone: customerPhone,
    },
    order_meta: {
      return_url: RETURN_URL, // Cashfree will replace {order_id}
      // 🔽 ADD: prefer UPI so intent icons can show when enabled on your merchant
      payment_methods: "upi",
      // notify_url: "...", // (optional) your webhook
    },
    // Tags help your frontend resume the right flow after redirect
    order_tags: {
      purpose: purpose || "boost",
      adId: adId || "",
      amount: String(amount),
      planDays: payload.planDays ? String(payload.planDays) : "",
    },
  };

  try {
    const json = await httpsJSON({
      host: CF_HOST,
      path: CF_ORDERS_PATH,
      method: "POST",
      headers: {
        "x-client-id": CF_APP_ID,
        "x-client-secret": CF_SECRET,
      },
      bodyObj: cfBody,
    });

    // expected: { order_id, payment_session_id, ... }
    return ok(json, event);
  } catch (e) {
    const status = e.statusCode || 500;
    const message =
      e.body?.message || e.message || "Failed to create order with Cashfree";
    return bad(status, message, event);
  }
};
