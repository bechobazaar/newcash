// netlify/functions/create-order.js
// Node 18+: uses global fetch

/* ---------------- CORS (dynamic: echo a single allowed origin) ---------------- */
function parseAllowedOriginsEnv() {
  const raw = process.env.ALLOWED_ORIGINS || "";
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}
const DEFAULT_ALLOWED = [
  "https://www.bechobazaar.com",
  "https://bechobazaar.com",
  "https://bechobazaar.netlify.app",
];

function cors(event) {
  const origin = event.headers?.origin || "";
  const wl = parseAllowedOriginsEnv();
  const list = wl.length ? wl : DEFAULT_ALLOWED;
  const allow = list.includes(origin) ? origin : list[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}
const ok  = (event, body)         => ({ statusCode: 200, headers: cors(event), body: JSON.stringify(body) });
const err = (event, status, body) => ({ statusCode: status, headers: cors(event), body: JSON.stringify(body) });

/* ---------------- Handler ---------------- */
exports.handler = async (event) => {
  // Preflight
  if (event.httpMethod === "OPTIONS") return ok(event, { ok: true });

  try {
    // Client payload (amount, purpose, adId); customer NOT required from client
    const { amount, purpose, adId } = JSON.parse(event.body || "{}");

    if (!amount || !purpose) {
      return err(event, 400, { message: "amount & purpose required" });
    }

    // Ensure Cashfree creds
    const APP_ID = process.env.CASHFREE_APP_ID;
    const SECRET = process.env.CASHFREE_SECRET_KEY;
    if (!APP_ID || !SECRET) {
      return err(event, 500, { message: "Cashfree keys missing (CASHFREE_APP_ID / CASHFREE_SECRET_KEY)" });
    }

    // Env & endpoints
    const CF_ENV = process.env.CASHFREE_ENV || "production"; // 'sandbox' | 'production'
    const BASE = CF_ENV === "sandbox"
      ? "https://sandbox.cashfree.com/pg"
      : "https://api.cashfree.com/pg";

    // Where Cashfree should return after payment (success/fail/cancel)
    const RETURN_URL = process.env.RETURN_URL
      || "https://www.bechobazaar.com/account.html?cf=1&order_id={order_id}";

    // Build Cashfree order payload
    const payload = {
      order_amount: Number(amount),
      order_currency: "INR",
      order_note: String(purpose),
      // Helpful context for resume on return
      order_tags: {
        purpose: String(purpose),
        adId: String(adId || ""),
        amount: String(amount || "")
      },
      // Dummy-but-valid customer info (no real email/phone needed)
      customer_details: {
        customer_id: "guest",
        customer_email: "anon@example.com",
        customer_phone: "9999999999"
      },
      order_meta: {
        return_url: RETURN_URL,
        notify_url: process.env.NOTIFY_URL || "" // optional webhook
      }
    };

    // Create order
    const r = await fetch(`${BASE}/orders`, {
      method: "POST",
      headers: {
        "x-client-id":     APP_ID,
        "x-client-secret": SECRET,
        "x-api-version":   "2022-09-01",
        "Content-Type":    "application/json"
      },
      body: JSON.stringify(payload)
    });

    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!r.ok) {
      // Pass-through Cashfree error so client can see exact reason
      return err(event, r.status, data);
    }

    // Success → return ids to client
    return ok(event, {
      order_id: data.order_id,
      payment_session_id: data.payment_session_id
    });
  } catch (e) {
    return err(event, 500, { error: e.message });
  }
};
