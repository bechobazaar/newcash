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

function decodeBase64(s) {
  try { return Buffer.from(s, "base64").toString("utf8"); } catch { return s; }
}

// very small quoted-printable decoder (handles =XX and soft breaks)
function decodeQP(s) {
  try {
    return s
      .replace(/=\r?\n/g, "")                      // soft line breaks
      .replace(/=([A-Fa-f0-9]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  } catch { return s; }
}

function looksBase64(s) {
  return /^[A-Za-z0-9+/=\r\n]+$/.test(s) && s.replace(/\s+/g,'').length % 4 === 0;
}

function stripHtml(html) {
  return String(html || '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractOtp(...texts) {
  const joined = texts.filter(Boolean).join(' ');
  // Common OTP patterns: 4–8 digits
  const m = joined.match(/\b(\d{4,8})\b(?!\s*(?:[A-Za-z]))/);
  return m ? m[1] : '';
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

    // 1) token
    const tokenResp = await json('POST', `${API}/token`, { address: email, password });
    const token = tokenResp && tokenResp.token;
    if (!token) throw new Error('no token from mail.tm');
    const auth = { Authorization: `Bearer ${token}` };

    // 2) list messages (first page)
    const list = await json('GET', `${API}/messages`, null, auth);
    const items = (list && list['hydra:member']) ? list['hydra:member'] : [];

    // 3) expand each
    const full = await Promise.all(items.map(async (m) => {
      try {
        const one = await json('GET', `${API}/messages/${m.id}`, null, auth);

        // Prefer HTML, then text, then intro
        let html = one.html || '';
        let text = '';

        // Sometimes providers put body into text as base64 / QP or only intro
        if (one.text) {
          text = Array.isArray(one.text) ? one.text.join('\n') : String(one.text);
        } else if (one.intro) {
          text = String(one.intro);
        }

        // Basic decoding heuristics
        if (looksBase64(text)) text = decodeBase64(text);
        if (/=\r?\n|=[A-Fa-f0-9]{2}/.test(text)) text = decodeQP(text);

        if (!html && text) {
          // create minimal HTML when html missing
          html = `<pre style="white-space:pre-wrap;font:14px/1.4 system-ui,Segoe UI,Roboto,Arial,sans-serif;">${text
            .replace(/[&<>]/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;' }[m]))}</pre>`;
        }

        // Subject/from/date
        const subject = one.subject || m.subject || '(no subject)';
        const from = (one.from && (one.from.address || one.from.name)) || (m.from && m.from.address) || '';
        const date = one.createdAt || m.createdAt || new Date().toISOString();

        // Extract OTP from multiple places
        const otp = extractOtp(subject, one.intro, stripHtml(html), text);

        // (Optional) mark seen:
        // try { await json('PATCH', `${API}/messages/${one.id}`, { seen: true }, auth); } catch {}

        return {
          id: one.id,
          from,
          subject,
          date,
          textBody: text || stripHtml(html),
          htmlBody: html,
          otp
        };
      } catch {
        return {
          id: m.id,
          from: (m.from && m.from.address) || '',
          subject: m.subject || '(no subject)',
          date: m.createdAt || '',
          textBody: '',
          htmlBody: '',
          otp: ''
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
