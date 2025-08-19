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

  try {
    const { amount, purpose, adId } = JSON.parse(event.body || "{}");
    if (!amount || !purpose) return err(400, { message: "amount & purpose required" });

    const CF_ENV = process.env.CASHFREE_ENV || "production";
    const BASE = CF_ENV === "sandbox"
      ? "https://sandbox.cashfree.com/pg"
      : "https://api.cashfree.com/pg";

    const RETURN_URL = "https://www.bechobazaar.com/account.html?cf=1&order_id={order_id}";

    const payload = {
      order_amount: Number(amount),
      order_currency: "INR",
      order_note: purpose,
      order_tags: { purpose, adId: String(adId || ""), amount: String(amount || "") },
      customer_details: { customer_id: "anon" }, // fill if you have real user info
      order_meta: {
        return_url: RETURN_URL,
        notify_url: process.env.NOTIFY_URL || "" // optional webhook
      }
    };

    const r = await fetch(`${BASE}/orders`, {
      method: "POST",
      headers: {
        "x-client-id": process.env.CASHFREE_APP_ID,
        "x-client-secret": process.env.CASHFREE_SECRET_KEY,
        "x-api-version": "2022-09-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await r.json();
    if (!r.ok) return err(r.status, data);

    return ok({
      order_id: data.order_id,
      payment_session_id: data.payment_session_id
    });
  } catch (e) {
    return err(500, { error: e.message });
  }
};
