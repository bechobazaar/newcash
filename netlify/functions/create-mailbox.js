// netlify/functions/create-mailbox.js
// Generate a 1secmail address locally (no upstream calls) to avoid 403/ratelimits.
const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
});

function randLogin() {
  const base = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36).slice(-4);
  return `bb${base}${ts}`; // e.g., bbk3u9xg2m5a
}

const DOMAINS = ["1secmail.com", "1secmail.org", "1secmail.net"];

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors(), body: "" };
  }
  try {
    const d = DOMAINS[Math.floor(Math.random() * DOMAINS.length)];
    const email = `${randLogin()}@${d}`;
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ email }) };
  } catch (e) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: String(e.message) }) };
  }
};
