// Get order status from Cashfree, returns { order_status, ... }
// URL: /.netlify/functions/get-order?order_id=xxxxx
const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

function corsHeaders(origin) {
  const allow = allowed.includes(origin) ? origin : (allowed[0] || "*");
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "OPTIONS, GET",
    "Access-Control-Max-Age": "86400",
  };
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || "";
  const headers = corsHeaders(origin);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const order_id = (event.queryStringParameters || {}).order_id;
  if (!order_id) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "order_id required" }) };
  }

  try {
    const base = process.env.CASHFREE_ENV === "PROD"
      ? "https://api.cashfree.com/pg"
      : "https://sandbox.cashfree.com/pg";

    const r = await fetch(`${base}/orders/${encodeURIComponent(order_id)}`, {
      method: "GET",
      headers: {
        "x-client-id": process.env.CASHFREE_APP_ID,
        "x-client-secret": process.env.CASHFREE_SECRET_KEY,
        "x-api-version": "2022-09-01",
      },
    });
    const d = await r.json();
    if (!r.ok) {
      return { statusCode: r.status, headers, body: JSON.stringify({ error: "lookup failed", details: d }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify(d) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "server error", details: e.message }) };
  }
};
