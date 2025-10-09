// netlify/functions/get-messages.js
// Returns messages with textBody + htmlBody (with inline CID images converted to data URLs).
const { Buffer } = require('buffer');
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
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let data;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt }; }
  if (!r.ok) {
    const msg = (data && (data.message || data.detail)) || `HTTP ${r.status}`;
    throw new Error(`${method} ${url} -> ${msg}`);
  }
  return data;
}
const escRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(), body: '' };
  }

  try {
    const qs = event.queryStringParameters || {};
    const email = (qs.email || '').trim();
    const password = (qs.password || '').trim();
    if (!email || !password) throw new Error('email and password are required');

    // 1) JWT
    const tokenResp = await json('POST', `${API}/token`, { address: email, password });
    const token = tokenResp && tokenResp.token;
    if (!token) throw new Error('no token from mail.tm');
    const authJson = { Authorization: `Bearer ${token}` };

    // 2) List
    const list = await json('GET', `${API}/messages`, null, authJson);
    const items = (list && list['hydra:member']) ? list['hydra:member'] : [];

    // 3) Expand
    const full = await Promise.all(items.map(async (m) => {
      try {
        const one = await json('GET', `${API}/messages/${m.id}`, null, authJson);

        // Text
        const text = one.text
          ? (Array.isArray(one.text) ? one.text.join('\n') : one.text)
          : '';

        // HTML
        let htmlBody = '';
        if (one.html) {
          htmlBody = typeof one.html === 'string' ? one.html
                   : Array.isArray(one.html) ? one.html.join('\n') : '';
        }

        // Inline CID attachments
        if (htmlBody && Array.isArray(one.attachments) && one.attachments.length) {
          for (const att of one.attachments) {
            const cidRaw = att.contentId || att.cid
              || (att.headers && (att.headers['content-id'] || att.headers['Content-Id']));
            if (!cidRaw) continue;

            try {
              const attUrl = `${API}/messages/${one.id}/attachments/${att.id}`;
              const res = await fetch(attUrl, { headers: { Authorization: `Bearer ${token}` } });
              if (!res.ok) continue;

              const buf = Buffer.from(await res.arrayBuffer());
              const mime = att.contentType || att.type || 'application/octet-stream';
              const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;

              const cleanCid = String(cidRaw).replace(/[<>]/g, '');
              const pat = new RegExp(`cid:\\s*<?${escRegex(cleanCid)}>?`, 'gi');
              htmlBody = htmlBody.replace(pat, dataUrl);
            } catch { /* ignore per-attachment failure */ }
          }
        }

        return {
          id: one.id,
          from: (one.from && (one.from.address || one.from.name)) || '',
          subject: one.subject || '(no subject)',
          date: one.createdAt || new Date().toISOString(),
          textBody: text,
          htmlBody
        };
      } catch {
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
