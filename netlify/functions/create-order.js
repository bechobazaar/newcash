// netlify/functions/create-order.js
const fetch = require("node-fetch");

const CF_ENV = process.env.CASHFREE_ENV || "production"; // "sandbox" | "production"
const APP_ID = process.env.CASHFREE_APP_ID;
const SECRET = process.env.CASHFREE_SECRET_KEY;

// CORS: single origin only (no multi-value header)
const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const cors = (origin) => ({
  "Access-Control-Allow-Origin": ALLOWED.includes(origin) ? origin : (ALLOWED[0] || origin || "*"),
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
});

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || "";
  const headers = cors(origin);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: "Method Not Allowed" };
  }

  try {
    const body = JSON.parse(event.body || "{}");

    const amount   = Number(body.amount || 0);
    const currency = String(body.currency || "INR").toUpperCase();
    const purpose  = String(body.purpose || "post_fee");
    const adId     = body.adId || null;

    // **No user input needed**: hum khud defaults bhar denge
    const rawUid = (body.customer && body.customer.id) || body.userId || "guest";
    const custId = ("cust_" + String(rawUid)).slice(0, 40); // dashboard me "Customer Ref ID"
    const custEmail = "pay@bechobazaar.com";                 // fixed, professional
    const custPhone = "9999999999";                          // fixed 10-digit

    if (!APP_ID || !SECRET) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "server not configured" }) };
    }
    if (!amount || amount < 1) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "invalid amount" }) };
    }

    const host = CF_ENV === "sandbox" ? "https://sandbox.cashfree.com" : "https://api.cashfree.com";
    const orderId = "order_" + Date.now();

    const payload = {
      order_id: orderId,
      order_amount: amount,
      order_currency: currency,
      customer_details: {
        customer_id: custId,
        customer_email: custEmail,
        customer_phone: custPhone,
      },
      order_meta: {
        // success ke baad yahin par aaoge; {order_id} auto replace hota hai
        return_url: `https://www.bechobazaar.com/account.html?cf=1&order_id={order_id}`,
      },
      // verify/resume ke liye context
      order_tags: { purpose, adId, amount },
      // (optional) order_note bhi daal sakte ho
      order_note: `${purpose} for ad ${adId || "na"}`
    };

    const res = await fetch(`${host}/pg/orders`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-version": "2022-09-01",
        "x-client-id": APP_ID,
        "x-client-secret": SECRET,
      },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    if (!res.ok) {
      return { statusCode: res.status, headers, body: text };
    }
    const data = JSON.parse(text);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        order_id: data.order_id,
        payment_session_id: data.payment_session_id,
        purpose, adId, amount
      }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "create-order failed", details: String(e?.message || e) }),
    };
  }
};
