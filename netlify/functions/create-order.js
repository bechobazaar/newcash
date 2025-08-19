// /.netlify/functions/create-order
const fetch = require("node-fetch");

exports.handler = async (event) => {
  try {
    const { amount, purpose, adId } = JSON.parse(event.body || "{}");

    // Cashfree keys from env
    const CASHFREE_APP_ID  = process.env.CF_APP_ID;
    const CASHFREE_SECRET  = process.env.CF_SECRET;
    const CF_ENV = process.env.CF_ENV || "production"; // "sandbox" | "production"
    const BASE = CF_ENV === "sandbox"
      ? "https://sandbox.cashfree.com/pg"
      : "https://api.cashfree.com/pg";

    // IMPORTANT: return_url — auto redirect back to account.html
    // We pass ?cf=1&order_id={order_id} so client can resume
    const RETURN_URL = "https://www.bechobazaar.com/account.html?cf=1&order_id={order_id}";

    // (Nice to have) Put context in order_tags so client can reconstruct after redirect
    const orderPayload = {
      order_amount: Number(amount),
      order_currency: "INR",
      order_note: purpose,
      order_tags: { purpose, adId: String(adId || ""), amount: String(amount || ""), },
      customer_details: {
        // optional but recommended
        customer_id: "anon",
        customer_email: "user@example.com"
      },
      order_meta: {
        return_url: RETURN_URL,
        notify_url: "https://bechobazaar.netlify.app/.netlify/functions/cf-webhook" // optional webhook
      }
    };

    const r = await fetch(`${BASE}/orders`, {
      method: "POST",
      headers: {
        "x-client-id": CASHFREE_APP_ID,
        "x-client-secret": CASHFREE_SECRET,
        "x-api-version": "2022-09-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(orderPayload)
    });

    const data = await r.json();
    if (!r.ok) {
      return { statusCode: r.status, body: JSON.stringify(data) };
    }

    // Return both order_id & payment_session_id to client
    return {
      statusCode: 200,
      body: JSON.stringify({
        order_id: data.order_id,
        payment_session_id: data.payment_session_id
      })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

