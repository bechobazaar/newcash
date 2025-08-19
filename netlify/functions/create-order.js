// Node 18+: uses global fetch. No 'node-fetch' needed.

// --- Dynamic CORS (echo a single allowed origin) ---
function parseAllowedOriginsEnv() {
  const raw = process.env.ALLOWED_ORIGINS || "";
  return raw
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}
const DEFAULT_ALLOWED = [
  "https://www.bechobazaar.com",
  "https://bechobazaar.com",
  "https://bechobazaar.netlify.app",
];

function cors(event) {
  const requestOrigin = event.headers?.origin || "";
  const allowed = parseAllowedOriginsEnv();
  const whitelist = allowed.length ? allowed : DEFAULT_ALLOWED;
  const allowOrigin = whitelist.includes(requestOrigin) ? requestOrigin : whitelist[0];

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}
const ok  = (event, body)           => ({ statusCode: 200, headers: cors(event), body: JSON.stringify(body) });
const err = (event, status, body)   => ({ statusCode: status, headers: cors(event), body: JSON.stringify(body) });

exports.handler = async (event) => {
  // Preflight
  if (event.httpMethod === "OPTIONS") return ok(event, { ok: true });

  try {
    const { amount, purpose, adId } = JSON.parse(event.body || "{}");
    if (!amount || !purpose) return err(event, 400, { message: "amount & purpose required" });

    // Cashfree env + base URL
    const CF_ENV = process.env.CASHFREE_ENV || "production"; // 'sandbox' | 'production'
    const BASE = CF_ENV === "sandbox"
      ? "https://sandbox.cashfree.com/pg"
      : "https://api.cashfree.com/pg";

    // Where Cashfree should send user back after payment (success/fail/cancel)
    const RETURN_URL = process.env.RETURN_URL
      || "https://www.bechobazaar.com/account.html?cf=1&order_id={order_id}";

    // Build payload
    const payload = {
      order_amount: Number(amount),
      order_currency: "INR",
      order_note: String(purpose),
      // Helpful for resume on return:
      order_tags: {
        purpose: String(purpose),
        adId: String(adId || ""),
        amount: String(amount || ""),
      },
      customer_details: {
        // (Optionally fill from your auth data)
        customer_id: "anon",
      },
      order_meta: {
        return_url: RETURN_URL,
        notify_url: process.env.NOTIFY_URL || ""  // Optional webhook
      }
    };

    // Create order
    const r = await fetch(`${BASE}/orders`, {
      method: "POST",
      headers: {
        "x-client-id":     process.env.CASHFREE_APP_ID,
        "x-client-secret": process.env.CASHFREE_SECRET_KEY,
        "x-api-version":   "2022-09-01",
        "Content-Type":    "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json();
    if (!r.ok) return err(event, r.status, data);

    return ok(event, {
      order_id: data.order_id,
      payment_session_id: data.payment_session_id
    });
  } catch (e) {
    return err(event, 500, { error: e.message });
  }
};

