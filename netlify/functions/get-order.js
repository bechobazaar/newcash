// netlify/functions/get-order.js
const fetch = require("node-fetch");

const CF_ENV = process.env.CASHFREE_ENV || "production"; // "sandbox" | "production"
const APP_ID = process.env.CASHFREE_APP_ID;
const SECRET = process.env.CASHFREE_SECRET_KEY;

// CORS: single origin only
const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const makeCors = (origin) => ({
  "Access-Control-Allow-Origin": ALLOWED.includes(origin)
    ? origin
    : (ALLOWED[0] || origin || "*"),
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
});

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || "";
  const headers = makeCors(origin);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers, body: "Method Not Allowed" };
  }

  const orderId = event.queryStringParameters && event.queryStringParameters.order_id;
  if (!orderId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "order_id required" }) };
  }
  if (!APP_ID || !SECRET) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "server not configured" }) };
  }

  try {
    const host = CF_ENV === "sandbox"
      ? "https://sandbox.cashfree.com"
      : "https://api.cashfree.com";

    const cfHeaders = {
      "x-api-version": "2022-09-01",
      "x-client-id": APP_ID,
      "x-client-secret": SECRET,
    };

    // 1) Order details
    const oRes = await fetch(`${host}/pg/orders/${encodeURIComponent(orderId)}`, {
      method: "GET",
      headers: cfHeaders,
    });
    const oText = await oRes.text();
    if (!oRes.ok) {
      return { statusCode: oRes.status, headers, body: oText };
    }
    const order = JSON.parse(oText);

    // 2) Latest payment (optional but helpful)
    let latestPayment = null;
    try {
      const pRes = await fetch(`${host}/pg/orders/${encodeURIComponent(orderId)}/payments`, {
        method: "GET",
        headers: cfHeaders,
      });
      if (pRes.ok) {
        const arr = await pRes.json();
        if (Array.isArray(arr) && arr.length) {
          latestPayment = arr.sort((a, b) => {
            const ta = new Date(a.payment_time || a.added_on || 0).getTime();
            const tb = new Date(b.payment_time || b.added_on || 0).getTime();
            return tb - ta;
          })[0];
        }
      }
    } catch (_) {}

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        order_id: order.order_id,
        order_status: order.order_status,            // e.g. PAID / ACTIVE / EXPIRED
        order_amount: order.order_amount,
        order_currency: order.order_currency,
        order_tags: order.order_tags || {},          // purpose/adId/amount (from create-order)
        payment_status: latestPayment?.payment_status, // e.g. SUCCESS / FAILED
        payment_amount: latestPayment?.payment_amount,
        payment_method: latestPayment?.payment_method?.display_name || latestPayment?.payment_method,
        cf_payment_id: latestPayment?.cf_payment_id,
      }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "get-order failed", details: String(e?.message || e) }),
    };
  }
};
