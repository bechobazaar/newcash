// Netlify Function: get-order
// Reads an order by ID, returns status + tags (used by client to resume & verify)

const ALLOWED_ORIGINS = [
  "https://www.bechobazaar.com",
  "https://bechobazaar.com",
  "https://bechobazaar.netlify.app"
];

const CF_ENV   = process.env.CASHFREE_ENV || "production";
const CF_BASE  = CF_ENV === "sandbox" ? "https://sandbox.cashfree.com/pg" : "https://api.cashfree.com/pg";
const APP_ID   = process.env.CASHFREE_APP_ID;
const SECRET   = process.env.CASHFREE_SECRET_KEY;

function cors(event) {
  const origin = event.headers.origin || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,GET"
  };
}

exports.handler = async (event) => {
  const headers = cors(event);

  if (event.httpMethod === "OPTIONS")
    return { statusCode: 200, headers, body: "" };

  if (event.httpMethod !== "GET")
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method Not Allowed" }) };

  const order_id = (event.queryStringParameters || {}).order_id;
  if (!order_id) return { statusCode: 400, headers, body: JSON.stringify({ error: "order_id required" }) };

  try {
    const res = await fetch(`${CF_BASE}/orders/${encodeURIComponent(order_id)}`, {
      method: "GET",
      headers: {
        "x-client-id": APP_ID,
        "x-client-secret": SECRET,
        "x-api-version": "2022-09-01"
      }
    });

    const data = await res.json();
    if (!res.ok) {
      return { statusCode: res.status, headers, body: JSON.stringify({ error: data?.message || "Cashfree get order error" }) };
    }

    // Normalize for client
    const out = {
      order_id: data.order_id,
      order_status: data.order_status,
      order_amount: data.order_amount,
      order_currency: data.order_currency,
      order_tags: data.order_tags || {}
    };
    return { statusCode: 200, headers, body: JSON.stringify(out) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message || "Server error" }) };
  }
};

