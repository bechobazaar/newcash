// Node 18+: uses global fetch (no node-fetch import)

const ok = (body) => ({ statusCode: 200, headers: cors(), body: JSON.stringify(body) });
const err = (status, body) => ({ statusCode: status, headers: cors(), body: JSON.stringify(body) });
const cors = () => ({
  "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGINS || "https://www.bechobazaar.com",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
});

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return ok({ ok: true });

  const order_id = event.queryStringParameters?.order_id;
  if (!order_id) return err(400, { message: "order_id required" });

  try {
    const CF_ENV = process.env.CASHFREE_ENV || "production";
    const BASE = CF_ENV === "sandbox"
      ? "https://sandbox.cashfree.com/pg"
      : "https://api.cashfree.com/pg";

    const r = await fetch(`${BASE}/orders/${encodeURIComponent(order_id)}`, {
      method: "GET",
      headers: {
        "x-client-id": process.env.CASHFREE_APP_ID,
        "x-client-secret": process.env.CASHFREE_SECRET_KEY,
        "x-api-version": "2022-09-01"
      }
    });

    const data = await r.json();
    if (!r.ok) return err(r.status, data);
    return ok(data);
  } catch (e) {
    return err(500, { error: e.message });
  }
};

