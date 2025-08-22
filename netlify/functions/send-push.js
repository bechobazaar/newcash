// /.netlify/functions/send-push.js
// Node 18+: global fetch available

const VERSION = 'send-push@2025-08-22-12-25IST';

const makeHeaders = (origin) => ({
  'Access-Control-Allow-Origin': origin || '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
  'Content-Type': 'application/json',
  'X-Func-Version': VERSION
});

function pickOrigin(event) {
  const reqOrigin = event.headers?.origin || '';
  const allow = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (allow.length === 0) return reqOrigin || '*';
  return allow.includes(reqOrigin) ? reqOrigin : allow[0]; // reflect first allowed to keep CORS happy
}

exports.handler = async (event) => {
  const origin = pickOrigin(event);
  const baseHeaders = makeHeaders(origin);

  // Always tell which method we saw
  const method = event.httpMethod || '';

  try {
    // 1) OPTIONS (CORS preflight)
    if (method === 'OPTIONS') {
      return {
        statusCode: 200,
        headers: baseHeaders,
        body: JSON.stringify({ ok: true, method, note: 'preflight' })
      };
    }

    // 2) TEMP: GET to verify function is reachable (helps kill “405 loop” confusion)
    if (method === 'GET') {
      return {
        statusCode: 200,
        headers: baseHeaders,
        body: JSON.stringify({
          ok: true,
          method,
          version: VERSION,
          how: 'Use POST with JSON body to send pushes to FCM.'
        })
      };
    }

    // 3) Only POST for real work
    if (method !== 'POST') {
      return {
        statusCode: 405,
        headers: baseHeaders,
        body: JSON.stringify({ error: 'Method Not Allowed', method })
      };
    }

    // 4) Parse body
    let bodyJson = {};
    try { bodyJson = JSON.parse(event.body || '{}'); } catch (e) {}
    const {
      tokens = [],
      title,
      body,
      url = '/',
      icon,
      badge,
      tag = 'bechobazaar',
      data = {}
    } = bodyJson;

    if (!Array.isArray(tokens) || tokens.length === 0) {
      return { statusCode: 400, headers: baseHeaders, body: JSON.stringify({ error: 'No tokens' }) };
    }

    const SERVER_KEY = process.env.FCM_SERVER_KEY;
    if (!SERVER_KEY) {
      return { statusCode: 500, headers: baseHeaders, body: JSON.stringify({ error: 'FCM_SERVER_KEY missing' }) };
    }

    // 5) Build FCM payload
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

    // 6) Send to FCM
    const res = await fetch('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `key=${SERVER_KEY}`
      },
      body: JSON.stringify(payload)
    });

    const json = await res.json();
    return {
      statusCode: res.ok ? 200 : 500,
      headers: baseHeaders,
      body: JSON.stringify({ ok: res.ok, fcm: json, version: VERSION })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: baseHeaders,
      body: JSON.stringify({ error: e.message || 'Error', version: VERSION })
    };
  }
};
