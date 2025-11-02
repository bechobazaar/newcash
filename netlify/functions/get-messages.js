// netlify/functions/get-messages.js
const API = 'https://api.mail.tm';
const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
});

async function json(method, url, body, headers) {
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...(headers || {}) },
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

function decodeBase64(b64) {
  try { return Buffer.from(b64, "base64").toString("utf8"); }
  catch { return b64; }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors(), body: "" };
  }

  try {
    const qs = event.queryStringParameters || {};
    const email = (qs.email || '').trim();
    const password = (qs.password || '').trim();
    if (!email || !password) throw new Error('email and password are required');

    // 1) Get token
    const tokenResp = await json('POST', `${API}/token`, { address: email, password });
    const token = tokenResp && tokenResp.token;
    if (!token) throw new Error('no token from mail.tm');
    const auth = { Authorization: `Bearer ${token}` };

    // 2) List messages
    const list = await json('GET', `${API}/messages`, null, auth);
    const items = (list && list['hydra:member']) ? list['hydra:member'] : [];

    // 3) Expand each message
    const full = await Promise.all(items.map(async (m) => {
      try {
        const one = await json('GET', `${API}/messages/${m.id}`, null, auth);

        let text = '';
        if (one.text) {
          if (Array.isArray(one.text)) text = one.text.join('\n');
          else text = one.text;
        } else if (one.intro) text = one.intro || '';
        else if (one.html) text = one.html || '';

        // If base64 encoded content detected
        if (/^[A-Za-z0-9+/=]+\s*$/.test(text) && text.length % 4 === 0)
          text = decodeBase64(text);

        return {
          id: one.id,
          from: (one.from && (one.from.address || one.from.name)) || '',
          subject: one.subject || '(no subject)',
          date: one.createdAt || new Date().toISOString(),
          textBody: text,
          htmlBody: one.html || text,
        };
      } catch (err) {
        return {
          id: m.id,
          from: (m.from && m.from.address) || '',
          subject: m.subject || '(no subject)',
          date: m.createdAt || '',
          textBody: '',
          htmlBody: ''
        };
      }
    }));

    full.sort((a, b) => new Date(b.date) - new Date(a.date));

    return { statusCode: 200, headers: cors(), body: JSON.stringify(full) };
  } catch (e) {
    if (String(e.message).includes('401') || String(e.message).includes('404')) {
      return { statusCode: 200, headers: cors(), body: JSON.stringify([]) };
    }
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: String(e.message) }) };
  }
};
