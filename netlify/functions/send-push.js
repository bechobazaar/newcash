// Node 18+: global fetch available

const headers = (origin) => ({
  'Access-Control-Allow-Origin': origin || '*',        // optionally lock down below
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
  'Content-Type': 'application/json'
});

function isAllowedOrigin(origin) {
  // Optional allowlist via env: e.g. "https://bechobazaar.netlify.app,https://bechobazaar.com"
  const allow = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allow.length === 0) return origin || '*'; // no allowlist => reflect or wildcard
  return allow.includes(origin) ? origin : null;
}

exports.handler = async (event) => {
  try {
    const origin = isAllowedOrigin(event.headers?.origin);
    const baseHeaders = headers(origin);

    // 1) Preflight
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers: baseHeaders, body: JSON.stringify({ ok: true }) };
    }

    // 2) Only POST allowed
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers: baseHeaders, body: JSON.stringify({ error: 'Method Not Allowed' }) };
    }

    // 3) Parse body
    const { tokens = [], title, body, url = '/', icon, badge, tag = 'bechobazaar', data = {} } =
      JSON.parse(event.body || '{}');

    if (!Array.isArray(tokens) || tokens.length === 0) {
      return { statusCode: 400, headers: baseHeaders, body: JSON.stringify({ error: 'No tokens' }) };
    }

    const SERVER_KEY = process.env.FCM_SERVER_KEY;
    if (!SERVER_KEY) {
      return { statusCode: 500, headers: baseHeaders, body: JSON.stringify({ error: 'FCM_SERVER_KEY missing' }) };
    }

    const payload = {
      registration_ids: tokens,
      notification: {
        title: title || 'New message',
        body:  body  || '',
        icon:  icon  || '/logo-192.png',
        badge: badge || '/badge-72.png',
        tag
      },
      data: { ...data, url },
      webpush: { fcm_options: { link: url } }
    };

    const res = await fetch('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `key=${SERVER_KEY}`
      },
      body: JSON.stringify(payload)
    });

    const json = await res.json();
    return { statusCode: res.ok ? 200 : 500, headers: baseHeaders, body: JSON.stringify(json) };
  } catch (e) {
    const origin = isAllowedOrigin(null);
    return { statusCode: 500, headers: headers(origin), body: JSON.stringify({ error: e.message || 'Error' }) };
  }
};
