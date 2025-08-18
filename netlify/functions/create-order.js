// Create Cashfree order + session, returns { order_id, payment_session_id }
// URL: /.netlify/functions/create-order
const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

function corsHeaders(origin) {
  const allow = allowed.includes(origin) ? origin : (allowed[0] || "*");
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "OPTIONS, POST, GET",
    "Access-Control-Max-Age": "86400",
  };
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || "";
  const headers = corsHeaders(origin);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const {
      amount,
      currency = "INR",
      purpose = "generic",
      adId = null,
      email = null,
      phone = null,
      userId = null,
    } = JSON.parse(event.body || "{}");

    if (!amount) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "amount required" }) };
    }

    const base = process.env.CASHFREE_ENV === "PROD"
      ? "https://api.cashfree.com/pg"
      : "https://sandbox.cashfree.com/pg";

    const order_id = `bbz_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const orderPayload = {
      order_id,
      order_amount: Number(amount),
      order_currency: currency,
      order_note: `${purpose}${adId ? ":" + adId : ""}`,
      customer_details: {
        customer_id: userId || `guest_${Date.now()}`,
        ...(email ? { customer_email: email } : {}),
        ...(phone ? { customer_phone: phone } : {}),
      },
    };

    // 1) Create order
    const r1 = await fetch(`${base}/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-client-id": process.env.CASHFREE_APP_ID,
        "x-client-secret": process.env.CASHFREE_SECRET_KEY,
        "x-api-version": "2022-09-01",
      },
      body: JSON.stringify(orderPayload),
    });
    const d1 = await r1.json();
    if (!r1.ok) {
      return { statusCode: r1.status, headers, body: JSON.stringify({ error: "create order failed", details: d1 }) };
    }

    // 2) Create session (to get payment_session_id for UI SDK)
    const r2 = await fetch(`${base}/orders/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-client-id": process.env.CASHFREE_APP_ID,
        "x-client-secret": process.env.CASHFREE_SECRET_KEY,
        "x-api-version": "2022-09-01",
      },
      body: JSON.stringify({ order_id }),
    });
    const d2 = await r2.json();
    if (!r2.ok) {
      return { statusCode: r2.status, headers, body: JSON.stringify({ error: "create session failed", details: d2 }) };
    }

    const payment_session_id = d2.payment_session_id || d1.payment_session_id || d1.order_token;
    return { statusCode: 200, headers, body: JSON.stringify({ order_id, payment_session_id }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "server error", details: e.message }) };
  }
};
