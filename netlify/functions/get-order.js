// Fetch Cashfree order details
const BASES = {
  PROD: "https://api.cashfree.com",
  SANDBOX: "https://sandbox.cashfree.com",
};

function corsHeaders(origin) {
  const allowed = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  const ok = allowed.includes(origin) ? origin : "";
  return ok
    ? {
        "Access-Control-Allow-Origin": ok,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      }
    : {};
}

exports.handler = async (event) => {
  const headers = corsHeaders(event.headers?.origin || event.headers?.Origin);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers };
  }
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, headers, body: "Method Not Allowed" };
  }

  try {
    const order_id = event.queryStringParameters?.order_id;
    if (!order_id) return { statusCode: 400, headers, body: JSON.stringify({ error: "order_id missing" }) };

    const appId = process.env.CASHFREE_APP_ID;
    const secret = process.env.CASHFREE_SECRET_KEY;
    const env = (process.env.CASHFREE_ENV || "SANDBOX").toUpperCase();
    const base = BASES[env] || BASES.SANDBOX;

    const res = await fetch(`${base}/pg/orders/${encodeURIComponent(order_id)}`, {
      method: "GET",
      headers: {
        "x-client-id": appId,
        "x-client-secret": secret,
        "x-api-version": "2022-09-01",
      },
    });

    const data = await res.json();
    const code = res.ok ? 200 : res.status;
    return {
      statusCode: code,
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(data),
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
