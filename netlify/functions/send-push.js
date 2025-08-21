// /.netlify/functions/send-push.js
const fetch = require('node-fetch');

const FCM_ENDPOINT = 'https://fcm.googleapis.com/fcm/send';

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body || '{}');
    let { tokens, title, body: msgBody, url, icon, badge, tag } = body;

    if (!Array.isArray(tokens) || tokens.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'No tokens' }) };
    }

    const payload = {
      registration_ids: tokens,
      priority: 'high',
      time_to_live: 2419200,
      notification: { title, body: msgBody, icon: icon || '/logo-192.png', badge: badge || '/badge-72.png', tag: tag || 'chat' },
      data: { title, body: msgBody, url: url || '/chat-list.html', icon, badge, tag }
    };

    const r = await fetch(FCM_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `key=${process.env.FCM_SERVER_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const text = await r.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

    return { statusCode: r.status, body: JSON.stringify({ status: r.status, result: json }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message || 'Error' }) };
  }
};
