// Node 18+: global fetch available
const VERSION = 'send-push@stable';

const corsHeaders = (origin) => ({
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
    .split(',').map(s => s.trim()).filter(Boolean);
  if (allow.length === 0) return reqOrigin || '*';
  return allow.includes(reqOrigin) ? reqOrigin : allow[0];
}

exports.handler = async (event) => {
  const origin = pickOrigin(event);
  const headers = corsHeaders(origin);
  const method = event.httpMethod || '';

  try {
    if (method === 'OPTIONS') {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, method }) };
    }
    if (method === 'GET') {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, method, version: VERSION }) };
    }
    if (method !== 'POST') {
      return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed', method }) };
    }

    const body = JSON.parse(event.body || '{}');
    const { tokens = [], title, body: nBody, url = '/', icon, badge, tag = 'bechobazaar', data = {} } = body;

    if (!Array.isArray(tokens) || tokens.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'No tokens' }) };
    }

    const SERVER_KEY = process.env.FCМ_SERVER_KEY || process.env.FCM_SERVER_KEY; // tolerate typo
    if (!SERVER_KEY) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'FCM_SERVER_KEY missing' }) };
    }

    const payload = {
      registration_ids: tokens,
      notification: {
        title: title || 'New message',
        body:  nBody || '',
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
    return { statusCode: res.ok ? 200 : 500, headers, body: JSON.stringify({ ok: res.ok, fcm: json }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message || 'Error' }) };
  }
};
