// netlify/functions/get-order.js
const { CASHFREE_APP_ID, CASHFREE_SECRET_KEY, CASHFREE_ENV, ALLOWED_ORIGINS } = process.env;

const CF_API_BASE =
  (CASHFREE_ENV || "production") === "sandbox"
    ? "https://sandbox.cashfree.com/pg"
    : "https://api.cashfree.com/pg";

function pickOrigin(event) {
  const reqOrigin = event.headers?.origin || "";
  const allow = (ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  return allow.includes(reqOrigin) ? reqOrigin : (allow[0] || "*");
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

exports.handler = async (event) => {
  const origin = pickOrigin(event);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(origin) };
  }

  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers: corsHeaders(origin), body: "Method Not Allowed" };
  }

  const orderId = event.queryStringParameters?.order_id;
  if (!orderId) {
    return { statusCode: 400, headers: corsHeaders(origin), body: "order_id required" };
  }

  try {
    const r = await fetch(`${CF_API_BASE}/orders/${encodeURIComponent(orderId)}`, {
      method: "GET",
      headers: {
        "x-client-id": CASHFREE_APP_ID,
        "x-client-secret": CASHFREE_SECRET_KEY,
        "x-api-version": "2022-09-01"
      }
    });

    const data = await r.json();

    if (!r.ok) {
      return {
        statusCode: r.status,
        headers: corsHeaders(origin),
        body: JSON.stringify({ error: "cashfree_error", details: data })
      };
    }

    // Minimal surface needed by client
    return {
      statusCode: 200,
      headers: corsHeaders(origin),
      body: JSON.stringify({
        order_id: data.order_id,
        order_status: data.order_status,
        order_amount: data.order_amount,
        order_currency: data.order_currency,
        order_tags: data.order_tags || null
      })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: corsHeaders(origin),
      body: JSON.stringify({ error: "server_error", message: e.message })
    };
  }
};
