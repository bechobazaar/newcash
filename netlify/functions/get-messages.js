// Client sends ?email=...&password=... ; we fetch JWT and list messages (text + html + inline CID images)
const API = 'https://api.mail.tm';

const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
});

async function json(method, url, body, headers){
  const r = await fetch(url, {
    method,
    headers: { "Content-Type":"application/json", ...(headers||{}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await r.text();
  let data; try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt }; }
  if(!r.ok){
    const msg = (data && (data.message || data.detail)) || `HTTP ${r.status}`;
    throw new Error(`${method} ${url} -> ${msg}`);
  }
  return data;
}

function escRegex(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors(), body: "" };
  }
  try {
    const qs = event.queryStringParameters || {};
    const email = (qs.email || '').trim();
    const password = (qs.password || '').trim();
    if(!email || !password) throw new Error('email and password are required');

    // 1) token
    const tokenResp = await json('POST', `${API}/token`, { address: email, password });
    const token = tokenResp && tokenResp.token;
    if(!token) throw new Error('no token from mail.tm');
    const authJson = { Authorization: `Bearer ${token}` };

    // 2) list messages
    const list = await json('GET', `${API}/messages`, null, authJson);
    const items = (list && list['hydra:member']) ? list['hydra:member'] : [];

    // 3) expand each message: text + html (+ inline CID images)
    const full = await Promise.all(items.map(async (m) => {
      try {
        const one = await json('GET', `${API}/messages/${m.id}`, null, authJson);

        // text
        const text = one.text || (Array.isArray(one.text) ? one.text.join('\n') : '') || '';

        // html
        let htmlBody = '';
        if (one.html) {
          if (typeof one.html === 'string') htmlBody = one.html;
          else if (Array.isArray(one.html)) htmlBody = one.html.join('\n');
        }

        // Inline CID attachments as data URLs (best effort)
        // mail.tm returns attachments array with contentId/headers; fetch binary and embed
        if (htmlBody && one.attachments && Array.isArray(one.attachments) && one.attachments.length) {
          for (const att of one.attachments) {
            const cid = att.contentId || att.cid || (att.headers && (att.headers['content-id'] || att.headers['Content-Id']));
            if (!cid) continue;
            try {
              const url = `${API}/messages/${one.id}/attachments/${att.id}`;
              const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
              if (!res.ok) continue;
              const buf = Buffer.from(await res.arrayBuffer());
              const mime = att.contentType || att.type || 'application/octet-stream';
              const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;

              // replace "cid:<cid>" (with/without angle brackets)
              const pat = new RegExp(`cid:\\s*<?${escRegex(String(cid).replace(/[<>]/g,''))}>?`, 'gi');
              htmlBody = htmlBody.replace(pat, dataUrl);
            } catch (_) { /* ignore single attachment failure */ }
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

    full.sort((a,b)=> new Date(b.date) - new Date(a.date));
    return { statusCode: 200, headers: cors(), body: JSON.stringify(full) };
  } catch (e) {
    // If creds expired/invalid, return empty array instead of hard error for smoother UX
    if (String(e.message).includes('401') || String(e.message).includes('404')) {
      return { statusCode: 200, headers: cors(), body: JSON.stringify([]) };
    }
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: String(e.message) }) };
  }
};
