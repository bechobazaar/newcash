// get-order.js — Netlify Function (https only)
// Reads a Cashfree order by ID + pulls payment attempts to expose "payment method"
// Clean CORS with single Access-Control-Allow-Origin value

const https = require("https");

const ENV      = process.env.CASHFREE_ENV === "sandbox" ? "sandbox" : "production";
const CF_HOST  = ENV === "sandbox" ? "sandbox.cashfree.com" : "api.cashfree.com";
const CF_APP_ID   = process.env.CASHFREE_APP_ID || "";
const CF_SECRET   = process.env.CASHFREE_SECRET_KEY || "";
const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

// 💡 Cashfree suggests newest versions; 2022-09-01 also works.
// If you’ve enabled newer APIs on your account, bump this to "2025-01-01".
const CF_API_VERSION = process.env.CASHFREE_API_VERSION || "2022-09-01";

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

function httpsJSON({ host, path, method = "GET", headers = {} }) {
  const opts = {
    host,
    path,
    method,
    headers: {
      "Content-Type": "application/json",
      "x-api-version": CF_API_VERSION,
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

/** Map Cashfree payment_group to a simple UI label */
function groupToLabel(g) {
  if (!g) return null;
  const x = String(g).toLowerCase();
  if (x === "upi") return "UPI";
  if (x === "credit_card" || x === "debit_card" || x === "card") return "Card";
  if (x === "net_banking" || x === "netbanking") return "Netbanking";
  if (x === "wallet" || x === "pay_later") return x.replace("_"," ").replace(/\b\w/g, c=>c.toUpperCase());
  return x.replace(/_/g, " ");
}

/** Pick latest SUCCESS (or most recent) payment attempt and summarize */
function summarizePayment(payments) {
  if (!Array.isArray(payments) || payments.length === 0) return null;

  // Prefer SUCCESS, else first element (Cashfree lists latest first)
  const byStatus = payments.find(p => String(p.payment_status).toUpperCase() === "SUCCESS");
  const pick = byStatus || payments[0];

  const group = pick.payment_group || null;
  const method = pick.payment_method || {};
  // Common masked details you might want to surface:
  // - method.upi?.upi_id
  // - method.card?.card_network, method.card?.card_type, method.card?.card_number (masked)
  // - method.netbanking?.netbanking_bank_code / netbanking_bank_name
  return {
    cf_payment_id: pick.cf_payment_id || null,
    payment_group: group || null,
    payment_label: groupToLabel(group),
    payment_method: method,             // keep raw (masked) object for admin/debug
    bank_reference: pick.bank_reference || null,
    payment_time: pick.payment_time || null,
    payment_status: pick.payment_status || null,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(event), body: "" };
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

    // 2) Payments for method info (separate endpoint)
    let payments = [];
    try {
      const pay = await httpsJSON({
        host: CF_HOST,
        path: `/pg/orders/${encodeURIComponent(orderId)}/payments`,
        method: "GET",
        headers: { "x-client-id": CF_APP_ID, "x-client-secret": CF_SECRET },
      });
      payments = Array.isArray(pay) ? pay : [];
    } catch (e) {
      // Don’t fail the whole call if payments fetch fails
      payments = [];
    }

    const payment_summary = summarizePayment(payments);

    // 3) Response: concise + tags for resume flow
    const resp = {
      order_id: order.order_id,
      order_status: order.order_status,
      cf_order_id: order.cf_order_id,
      order_amount: order.order_amount,
      order_currency: order.order_currency,
      order_tags: order.order_tags || {},
      // Optional raw attempts (comment out if you want lean response)
      payments,
      // 🆕 Friendly summary for UI & Firestore
      payment_summary,
    };

    return ok(resp, event);
  } catch (e) {
    const status = e.statusCode || 500;
    const message =
      e.body?.message || e.message || "Failed to fetch order from Cashfree";
    return bad(status, message, event);
  }
};
