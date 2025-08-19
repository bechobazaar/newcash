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

  const order_id = event.queryStringParameters?.order_id;
  if (!order_id) return err(event, 400, { message: "order_id required" });

  try {
    const CF_ENV = process.env.CASHFREE_ENV || "production";
    const BASE = CF_ENV === "sandbox"
      ? "https://sandbox.cashfree.com/pg"
      : "https://api.cashfree.com/pg";

    const r = await fetch(`${BASE}/orders/${encodeURIComponent(order_id)}`, {
      method: "GET",
      headers: {
        "x-client-id":     process.env.CASHFREE_APP_ID,
        "x-client-secret": process.env.CASHFREE_SECRET_KEY,
        "x-api-version":   "2022-09-01",
      }
    });

    const data = await r.json();
    if (!r.ok) return err(event, r.status, data);
    return ok(event, data); // includes order_status, order_tags, etc.
  } catch (e) {
    return err(event, 500, { error: e.message });
  }
};
