// Create Cashfree order and return payment_session_id
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
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      }
    : {};
}

exports.handler = async (event) => {
  const headers = corsHeaders(event.headers?.origin || event.headers?.Origin);

  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: "Method Not Allowed" };
  }

  try {
    const { amount, currency = "INR", customer = {}, meta = {} } = JSON.parse(event.body || "{}");
    if (!amount) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "amount missing" }) };
    }

    const appId = process.env.CASHFREE_APP_ID;
    const secret = process.env.CASHFREE_SECRET_KEY;
    const env = (process.env.CASHFREE_ENV || "SANDBOX").toUpperCase();
    const base = BASES[env] || BASES.SANDBOX;

    const order_id = meta.order_id || `order_${Date.now()}`;

    const res = await fetch(`${base}/pg/orders`, {
      method: "POST",
      headers: {
        "x-client-id": appId,
        "x-client-secret": secret,
        "x-api-version": "2022-09-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        order_id,
        order_amount: Number(amount),
        order_currency: currency,
        customer_details: {
          customer_id: customer.id || `cust_${Date.now()}`,
          customer_name: customer.name || "Guest",
          customer_email: customer.email || "guest@example.com",
          customer_phone: customer.phone || "9999999999",
        },
        // optional: return_url or notify_url if you ever need
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      return { statusCode: res.status, headers, body: JSON.stringify({ error: data }) };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({
        ok: true,
        env,
        order_id: data.order_id,
        payment_session_id: data.payment_session_id,
        order_status: data.order_status,
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

