// netlify/functions/list-domains.js
const API = 'https://api.mail.tm';

const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
});

async function json(method, url) {
  const r = await fetch(url, { method, headers: { "Accept": "application/json" }});
  const txt = await r.text();
  let data; try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt }; }
  if (!r.ok) throw new Error(`${method} ${url} -> HTTP ${r.status}`);
  return data;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors(), body: "" };
  }
  try {
    // mail.tm domains endpoint is paginated; fetch first 100
    const res = await json('GET', `${API}/domains?page=1&itemsPerPage=100`);
    const items = res && res['hydra:member'] ? res['hydra:member'] : [];
    const domains = items
      .map(d => (typeof d === 'string' ? d : d.domain || d.name || '').trim())
      .filter(Boolean);
    return { statusCode: 200, headers: cors(), body: JSON.stringify(domains) };
  } catch (e) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: String(e.message) }) };
  }
};
