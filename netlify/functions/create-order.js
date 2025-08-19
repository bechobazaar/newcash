// Netlify Function: create-order
// Creates/Upserts a Cashfree customer with your Firebase UID and then creates an order
// Returns: { order_id, payment_session_id, cf_order } and echoes order_tags for debugging

const ALLOWED_ORIGINS = [
  "https://www.bechobazaar.com",
  "https://bechobazaar.com",
  "https://bechobazaar.netlify.app" 
];

const CF_ENV   = process.env.CASHFREE_ENV || "production"; // "sandbox" | "production"
const CF_BASE  = CF_ENV === "sandbox" ? "https://sandbox.cashfree.com/pg" : "https://api.cashfree.com/pg";
const APP_ID   = process.env.CASHFREE_APP_ID;
const SECRET   = process.env.CASHFREE_SECRET_KEY;
const RETURN_URL_TPL = process.env.RETURN_URL || "https://www.bechobazaar.com/account.html?cf=1&order_id={order_id}";
const NOTIFY_URL     = process.env.CASHFREE_NOTIFY_URL || undefined;

function cors(event) {
  const origin = event.headers.origin || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  const headers = {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,POST"
  };
  return headers;
}

function bad(status, message, headers) {
  return { statusCode: status, headers, body: JSON.stringify({ error: message }) };
}

function requireEnv() {
  if (!APP_ID || !SECRET) throw new Error("Cashfree credentials missing");
}

function nowOrderId() {
  // unique, readable order id
  const rand = Math.random().toString(36).slice(2, 8);
  return `order_${Date.now()}_${rand}`;
}

exports.handler = async (event) => {
  const headers = cors(event);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return bad(405, "Method Not Allowed", headers);
  }

  try {
    requireEnv();

    const body = JSON.parse(event.body || "{}");
    const { amount, currency = "INR", purpose, adId, planDays, customer } = body;

    if (!amount || !purpose) return bad(400, "amount & purpose required", headers);

    // ---- Map client customer -> Cashfree customer_details ----
    // We always prefer your Firebase UID as the persistent customer_id
    let customer_id = customer?.id || customer?.customer_id || null;
    if (customer_id) customer_id = String(customer_id);

    const customer_email = customer?.email || "anon@example.com";
    const customer_phone = customer?.phone || "9999999999";

    // 1) Idempotent upsert the customer (ensures dashboard shows ref id instead of "guest")
    if (customer_id) {
      const putRes = await fetch(`${CF_BASE}/customers/${encodeURIComponent(customer_id)}`, {
        method: "PUT",
        headers: {
          "x-client-id": APP_ID,
          "x-client-secret": SECRET,
          "x-api-version": "2022-09-01",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          // Cashfree expects these exact keys:
          customer_id: customer_id,
          customer_email,
          customer_phone
        })
      });

      // We ignore 200/201/204 variations; but if hard error, surface it
      if (!putRes.ok && putRes.status >= 400 && putRes.status < 500) {
        const t = await putRes.text();
        console.warn("Cashfree PUT /customers failed:", putRes.status, t);
        // We can still proceed without a registered customer; order will be 'guest'
      }
    }

    // 2) Create order
    const order_id = nowOrderId();

    const order_tags = Object.fromEntries(
      Object.entries({
        purpose,
        adId,
        amount: String(amount),
        planDays: planDays != null ? String(planDays) : undefined
      }).filter(([_, v]) => v !== undefined)
    );

    const orderMeta = {
      return_url: RETURN_URL_TPL.replace("{order_id}", order_id)
    };
    if (NOTIFY_URL) orderMeta.notify_url = NOTIFY_URL;

    const payload = {
      order_id,
      order_amount: Number(amount),
      order_currency: currency,
      customer_details: customer_id
        ? { customer_id } // **THIS** makes the dashboard show your ref id
        : { customer_email, customer_phone }, // fallback: still not "guest" sometimes, but ref id may be absent
      order_meta: orderMeta,
      order_tags
    };

    const res = await fetch(`${CF_BASE}/orders`, {
      method: "POST",
      headers: {
        "x-client-id": APP_ID,
        "x-client-secret": SECRET,
        "x-api-version": "2022-09-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) {
      console.error("Cashfree /orders error", res.status, data);
      return bad(res.status, data?.message || "Cashfree order error", headers);
    }

    // Expected fields: payment_session_id, order_id, etc.
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        order_id: data.order_id || order_id,
        payment_session_id: data.payment_session_id,
        cf_order: data,
        order_tags // echo for debugging on client
      })
    };
  } catch (e) {
    console.error(e);
    return bad(500, e.message || "Server error", headers);
  }
};

