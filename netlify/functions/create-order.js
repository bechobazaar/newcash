// create-order.js — Netlify Function
// Creates Cashfree order -> returns { order_id, payment_session_id, ... }
// CORS allowlist (single Access-Control-Allow-Origin)

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

// 👇 yahan se tum control kar sakte ho ki checkout me kaunse methods dikhein
// e.g. "upi,card"  (Cards = credit+debit; UPI = collect+intent if merchant par enabled)
// Agar kabhi error aaye to isse "" (empty) kardo -> Cashfree all enabled methods dikhayega
const CF_PAYMENT_METHODS = process.env.CF_PAYMENT_METHODS || "upi,card";

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
  return { statusCode: 200, headers: corsHeaders(event), body: JSON.stringify(body) };
}
function bad(status, msg, event) {
  return { statusCode: status, headers: corsHeaders(event), body: JSON.stringify({ error: msg }) };
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
  if (bodyStr) opts.headers["Content-Length"] = Buffer.byteLength(bodyStr);

  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else {
            const err = new Error(`CF ${method} ${path} ${res.statusCode}: ${data}`);
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
  const r = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${Date.now()}_${r}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(event), body: "" };
  }
  if (event.httpMethod !== "POST") return bad(405, "Method Not Allowed", event);
  if (!CF_APP_ID || !CF_SECRET) return bad(500, "Cashfree credentials missing on server", event);

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (_) {
    return bad(400, "Invalid JSON", event);
  }

  const amount = Number(payload.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return bad(400, "amount must be a positive number", event);
  }

  const currency = (payload.currency || "INR").toUpperCase();
  const purpose = String(payload.purpose || "");
  const adId = payload.adId ? String(payload.adId) : "";

  const customer = payload.customer || {};
  const customerId = String(customer.id || "guest");

  const customerEmail = "guest@bechobazaar.com";
  const customerPhone = "9999999999";

  const orderId = genOrderId("bb");

  // ----- Build order -----
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
      return_url: RETURN_URL,
      // 👇 yahi line dono show karayegi: UPI (incl. intent) + Card
      // Cashfree v2022-09-01 expects a CSV string.
      ...(CF_PAYMENT_METHODS
        ? { payment_methods: CF_PAYMENT_METHODS }
        : {}), // if empty -> let Cashfree decide from merchant config
    },
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
    return ok(json, event);
  } catch (e) {
    // Fallback: agar kisi reason se payment_methods reject ho jaye to
    // ek aur try bina payment_methods ke (optional). Comment out if not needed.
    if (e.statusCode === 400 && /payment_methods/i.test(e.body?.message || "")) {
      try {
        const json2 = await httpsJSON({
          host: CF_HOST,
          path: CF_ORDERS_PATH,
          method: "POST",
          headers: {
            "x-client-id": CF_APP_ID,
            "x-client-secret": CF_SECRET,
          },
          bodyObj: { ...cfBody, order_meta: { return_url: RETURN_URL } },
        });
        return ok(json2, event);
      } catch (e2) {
        const status2 = e2.statusCode || 500;
        const msg2 = e2.body?.message || e2.message || "Failed to create order with Cashfree";
        return bad(status2, msg2, event);
      }
    }

    const status = e.statusCode || 500;
    const msg = e.body?.message || e.message || "Failed to create order with Cashfree";
    return bad(status, msg, event);
  }
};
