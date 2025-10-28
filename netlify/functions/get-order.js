// get-order.js — Netlify Function (https only)
// Reads a Cashfree order by ID + pulls payment attempts (to expose payment method)
// Adds: normalized status flags, resilient payments parsing, Cache-Control:no-store

const https = require("https");

const ENV       = process.env.CASHFREE_ENV === "sandbox" ? "sandbox" : "production";
const CF_HOST   = ENV === "sandbox" ? "sandbox.cashfree.com" : "api.cashfree.com";
const CF_APP_ID = process.env.CASHFREE_APP_ID || "";
const CF_SECRET = process.env.CASHFREE_SECRET_KEY || "";
const ALLOWED   = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

// Use your enabled API version; 2022-09-01 works widely.
// If your account supports it, set CASHFREE_API_VERSION=2025-01-01
const CF_API_VERSION = process.env.CASHFREE_API_VERSION || "2022-09-01";

/* ---------------- CORS + headers ---------------- */
function pickOrigin(event) {
  const reqOrigin = event.headers?.origin || event.headers?.Origin || event.headers?.ORIGIN || "";
  if (ALLOWED.includes(reqOrigin)) return reqOrigin;
  return ALLOWED[0] || "";
}
function baseHeaders(event) {
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Cache-Control": "no-store",               // don't cache order status
  };
  const o = pickOrigin(event);
  if (o) h["Access-Control-Allow-Origin"] = o;
  return h;
}
const ok  = (body, event) => ({ statusCode: 200, headers: baseHeaders(event), body: JSON.stringify(body) });
const bad = (status, msg, event) => ({ statusCode: status, headers: baseHeaders(event), body: JSON.stringify({ error: msg }) });

/* ---------------- tiny https client ---------------- */
function httpsJSON({ host, path, method = "GET", headers = {} }) {
  const opts = {
    host,
    path,
    method,
    headers: { "Content-Type": "application/json", "x-api-version": CF_API_VERSION, ...headers },
  };
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
    req.end();
  });
}

/* ---------------- helpers ---------------- */
function groupToLabel(g) {
  if (!g) return null;
  const x = String(g).toLowerCase();
  if (x === "upi") return "UPI";
  if (x === "credit_card" || x === "debit_card" || x === "card") return "Card";
  if (x === "net_banking" || x === "netbanking") return "Netbanking";
  if (x === "wallet" || x === "pay_later") return x.replace("_"," ").replace(/\b\w/g, c=>c.toUpperCase());
  return x.replace(/_/g, " ");
}

/** Normalize different shapes that Cashfree may return for payments */
function normalizePayments(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.payments)) return raw.payments; // some versions wrap it
  return [];
}

/** Prefer latest SUCCESS, else most recent */
function summarizePayment(payments) {
  const list = normalizePayments(payments);
  if (list.length === 0) return null;

  const bySuccess = list.find(p => String(p.payment_status).toUpperCase() === "SUCCESS");
  const pick = bySuccess || list[0];

  const group  = pick.payment_group || null;
  const method = pick.payment_method || {};

  // Try to surface app/bank name for friendlier UI (best-effort)
  let method_note = null;
  if (method.upi) {
    method_note = method.upi.upi_app || method.upi.channel || method.upi.vpa || null;
  } else if (method.card) {
    method_note = [method.card.card_network, method.card.card_type].filter(Boolean).join(" ");
  } else if (method.netbanking) {
    method_note = method.netbanking.netbanking_bank_name || method.netbanking.netbanking_bank_code || null;
  }

  return {
    cf_payment_id: pick.cf_payment_id || null,
    payment_group: group || null,
    payment_label: groupToLabel(group),
    payment_method: method,             // masked nested details
    payment_method_note: method_note,   // friendly hint (e.g., "GPay", "HDFC")
    bank_reference: pick.bank_reference || null,
    payment_time: pick.payment_time || null,
    payment_status: pick.payment_status || null,
  };
}

/* ---------------- handler ---------------- */
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: baseHeaders(event), body: "" };
  }
  if (event.httpMethod !== "GET") return bad(405, "Method Not Allowed", event);
  if (!CF_APP_ID || !CF_SECRET) return bad(500, "Cashfree credentials missing on server", event);

  const orderId = event.queryStringParameters?.order_id;
  if (!orderId) return bad(400, "order_id is required", event);

  try {
    // 1) Order
    const order = await httpsJSON({
      host: CF_HOST,
      path: `/pg/orders/${encodeURIComponent(orderId)}`,
      method: "GET",
      headers: { "x-client-id": CF_APP_ID, "x-client-secret": CF_SECRET },
    });

    // 2) Payments (for method info)
    let payments = [];
    try {
      const pay = await httpsJSON({
        host: CF_HOST,
        path: `/pg/orders/${encodeURIComponent(orderId)}/payments`,
        method: "GET",
        headers: { "x-client-id": CF_APP_ID, "x-client-secret": CF_SECRET },
      });
      payments = normalizePayments(pay);
    } catch (_) {
      payments = [];
    }

    const payment_summary = summarizePayment(payments);

    // Normalized flags
    const statusUpper = String(order.order_status || "").toUpperCase();
    const is_paid = statusUpper === "PAID" || statusUpper === "SUCCESS";
    const is_pending = statusUpper === "ACTIVE" || statusUpper === "PENDING";

    // Response (keeps your compatibility fields)
    const resp = {
      order_id: order.order_id,
      order_status: order.order_status,     // raw
      status: order.order_status,           // compatibility mirror
      cf_order_id: order.cf_order_id,
      order_amount: order.order_amount,
      order_currency: order.order_currency,
      order_tags: order.order_tags || {},
      payments,                             // raw attempts (optional; keep for analytics)
      payment_summary,                      // friendly summary
      payment_method: payment_summary?.payment_method || null, // for frontend convenience
      // Extras:
      status_upper: statusUpper,
      is_paid,
      is_pending,
    };

    return ok(resp, event);
  } catch (e) {
    const status = e.statusCode || 500;
    const message = e.body?.message || e.message || "Failed to fetch order from Cashfree";
    return bad(status, message, event);
  }
};
