
/**
 * Netlify Function: send-push
 * - Uses FCM Legacy HTTP API (no OAuth needed)
 * - Expects POST JSON: { tokens: string[], title, body, url, icon, badge, tag, data? }
 * - CORS: allows GET (diagnostic), OPTIONS (preflight), POST
 * - Requires env: FCM_SERVER_KEY (Firebase Cloud Messaging Legacy server key)
 */

const FCM_URL = 'https://fcm.googleapis.com/fcm/send';

function corsHeaders(origin, allowedList) {
  const list = (allowedList || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const allow = list.length === 0 || (origin && list.includes(origin));
  return {
    'Access-Control-Allow-Origin': allow ? (origin || '*') : '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Type': 'application/json'
  };
}

exports.handler = async (event) => {
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const headers = corsHeaders(origin, process.env.ALLOWED_ORIGINS);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        method: 'GET',
        version: 'send-push@v3',
        how: 'POST JSON: { tokens[], title, body, url, icon, badge, tag, data? }'
      })
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, error: 'Method not allowed' })
    };
  }

  const serverKey = process.env.FCM_SERVER_KEY;
  if (!serverKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: 'Missing env FCM_SERVER_KEY' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'Invalid JSON', detail: String(e) }) };
  }

  let { tokens, title, body: msgBody, url, icon, badge, tag, data } = body || {};
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'tokens[] required' }) };
  }
  tokens = Array.from(new Set(tokens.filter(Boolean)));
  if (tokens.length === 0) {
    return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'No valid tokens' }) };
  }

  // Data-only payload (SW will show notification using this info)
  const dataPayload = Object.assign({}, data || {}, {
    title: String(title || ''),
    body: String(msgBody || ''),
    url: String(url || '/'),
    icon: String(icon || '/logo-192.png'),
    badge: String(badge || '/badge-72.png'),
    tag: String(tag || '')
  });

  const chunks = [];
  for (let i = 0; i < tokens.length; i += 1000) chunks.push(tokens.slice(i, i + 1000));

  const results = [];
  for (const chunk of chunks) {
    const fcmBody = {
      registration_ids: chunk,
      data: dataPayload,
      priority: 'high',
      webpush: { fcm_options: { link: dataPayload.url } }
    };

    const res = await fetch(FCM_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'key=' + serverKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(fcmBody)
    });

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

    results.push({ status: res.status, response: json });

    if (!res.ok) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ ok: false, error: 'FCM error', details: json })
      };
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, sent: tokens.length, batches: results.length, results })
  };
};
