// netlify/functions/create-order.js
// Node 18+ (global fetch). No node-fetch needed.

const { CASHFREE_APP_ID, CASHFREE_SECRET_KEY, CASHFREE_ENV, ALLOWED_ORIGINS, PUBLIC_BASE } = process.env;

const CF_API_BASE =
  (CASHFREE_ENV || "production") === "sandbox"
    ? "https://sandbox.cashfree.com/pg"
    : "https://api.cashfree.com/pg";

function pickOrigin(event) {
  const reqOrigin = event.headers?.origin || "";
  const allow = (ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  // If request origin is in allowlist, use it. Else use the first allowlisted origin (if any)
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
    // Preflight
    return { statusCode: 204, headers: corsHeaders(origin) };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders(origin), body: "Method Not Allowed" };
  }

  try {
    if (!CASHFREE_APP_ID || !CASHFREE_SECRET_KEY) {
      return { statusCode: 500, headers: corsHeaders(origin), body: "Cashfree keys missing" };
    }

    const body = JSON.parse(event.body || "{}");
    const amount = Number(body.amount);
    const currency = (body.currency || "INR").toUpperCase();
    const purpose = (body.purpose || "").toLowerCase();         // 'boost' | 'post_fee'
    const adId = body.adId || null;
    const planDays = body.planDays ? Number(body.planDays) : undefined;

    const uid = body.customer?.id || "guest";                    // <— will be your Firebase UID from client
    const email = body.customer?.email;
    const phone = body.customer?.phone;

    if (!amount || !purpose || !adId) {
      return { statusCode: 400, headers: corsHeaders(origin), body: "amount/purpose/adId required" };
    }

    const orderId = `bb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const payloadCF = {
      order_id: orderId,
      order_amount: amount,
      order_currency: currency,
      customer_details: {
        customer_id: uid,                // <— IMPORTANT: not "guest" now
        ...(email ? { customer_email: email } : {}),
        ...(phone ? { customer_phone: phone } : {})
      },
      order_meta: {
        // Cashfree will replace {order_id} server-side
        return_url: `${(PUBLIC_BASE || "https://www.bechobazaar.com").replace(/\/+$/, "")}/account.html?cf=1&order_id={order_id}`
      },
      order_tags: {
        purpose, adId, amount, planDays, userId: uid
      }
    };

    const r = await fetch(`${CF_API_BASE}/orders`, {
      method: "POST",
      headers: {
        "x-client-id": CASHFREE_APP_ID,
        "x-client-secret": CASHFREE_SECRET_KEY,
        "x-api-version": "2022-09-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payloadCF)
    });

    const data = await r.json();

    if (!r.ok) {
      return {
        statusCode: r.status,
        headers: corsHeaders(origin),
        body: JSON.stringify({ error: "cashfree_error", details: data })
      };
    }

    return {
      statusCode: 200,
      headers: corsHeaders(origin),
      body: JSON.stringify({
        order_id: data.order_id,
        payment_session_id: data.payment_session_id,
        order_status: data.order_status || "CREATED"
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders(origin),
      body: JSON.stringify({ error: "server_error", message: err.message })
    };
  }
};
