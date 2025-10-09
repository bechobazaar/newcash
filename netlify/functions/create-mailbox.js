// netlify/functions/create-mailbox.js
const API = 'https://api.mail.tm';

const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
});

function rand(n=10) {
  const abc = 'abcdefghijkmnopqrstuvwxyz0123456789';
  let s=''; for (let i=0;i<n;i++) s += abc[Math.floor(Math.random()*abc.length)];
  return s;
}

async function json(method, url, body, headers) {
  const r = await fetch(url, {
    method,
    headers: { "Content-Type":"application/json", ...(headers||{}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await r.text();
  let data; try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt }; }
  if (!r.ok) {
    const msg = (data && (data.message || data.detail)) || `HTTP ${r.status}`;
    throw new Error(`${method} ${url} -> ${msg}`);
  }
  return data;
}

async function pickDomain(preferred) {
  // If preferred provided, try to use it (exact match against mail.tm list)
  const res = await json('GET', `${API}/domains?page=1&itemsPerPage=100`);
  const items = res && res['hydra:member'] ? res['hydra:member'] : [];
  const domains = items
    .map(d => (typeof d === 'string' ? d : d.domain || d.name || '').trim())
    .filter(Boolean);

  if (!domains.length) throw new Error('No domains available from mail.tm');

  if (preferred) {
    const hit = domains.find(d => d.toLowerCase() === preferred.toLowerCase());
    if (!hit) throw new Error(`Requested domain not available: ${preferred}`);
    return hit;
  }
  // random
  return domains[Math.floor(Math.random() * domains.length)];
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors(), body: "" };
  }
  try {
    const qs = event.queryStringParameters || {};
    const preferredDomain = (qs.domain || '').trim();

    // 1) choose domain
    const domain = await pickDomain(preferredDomain);

    // 2) create account
    const local = `bb${rand(8)}`;           // local-part
    const address = `${local}@${domain}`;
    const password = rand(14) + 'A!';       // meet policy

    // create account
    await json('POST', `${API}/accounts`, { address, password });

    // Sometimes creation is eventually consistent; small delay helps
    await new Promise(r => setTimeout(r, 250));

    // 3) get token (to validate)
    const tokenResp = await json('POST', `${API}/token`, { address, password });
    const token = tokenResp && tokenResp.token;
    if (!token) throw new Error('Token not returned');

    return {
      statusCode: 200,
      headers: cors(),
      body: JSON.stringify({ email: address, password, domain })
    };
  } catch (e) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: String(e.message) }) };
  }
};
