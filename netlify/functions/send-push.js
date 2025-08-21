// netlify/functions/send-push.js
const fetch = require('node-fetch');
const FCM_ENDPOINT = 'https://fcm.googleapis.com/fcm/send';

// Allowed origins (same-origin + optional prod domain)
const ALLOWED = new Set([
  'https://bechobazaar.netlify.app',
  'https://www.bechobazaar.com',     // keep if you call cross-domain
  'http://localhost:8888',           // netlify dev
  'http://localhost:3000'
]);

function corsHeaders(origin) {
  const allow = ALLOWED.has(origin) ? origin : 'https://bechobazaar.netlify.app';
  return {
    'Access-Control-Allow-Origin': allow,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

exports.handler = async (event) => {
  const origin = event.headers.origin || '';
  const CORS = corsHeaders(origin);

  // Preflight (CORS)
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  // Health check in browser
  if (event.httpMethod === 'GET') {
    return { statusCode: 200, headers: CORS, body: 'send-push OK' };
  }

  try {
    const { tokens, title, body, url, icon, badge, tag } = JSON.parse(event.body || '{}');

    if (!Array.isArray(tokens) || tokens.length === 0) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No tokens' }) };
    }

    // dedupe/clean tokens
    const regIds = [...new Set(tokens)].filter(Boolean);

    const payload = {
      registration_ids: regIds,
      priority: 'high',
      time_to_live: 2419200,
      notification: {
        title,
        body,
        icon: icon || '/logo-192.png',
        badge: badge || '/badge-72.png',
        tag: tag || 'chat'
      },
      data: { title, body, url: url || '/chat-list.html', icon, badge, tag }
    };

    const r = await fetch(FCM_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `key=${process.env.FCM_SERVER_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const txt = await r.text();
    return { statusCode: r.status, headers: CORS, body: txt };
  } catch (e) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: e.message || 'Error' }) };
  }
};
