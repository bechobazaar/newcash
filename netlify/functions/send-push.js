const fetch = require('node-fetch');
const FCM_ENDPOINT = 'https://fcm.googleapis.com/fcm/send';

exports.handler = async (event) => {
  try {
    const { tokens, title, body, url, icon, badge, tag } = JSON.parse(event.body || '{}');
    if (!Array.isArray(tokens) || tokens.length === 0) return { statusCode: 400, body: 'No tokens' };

    const payload = {
      registration_ids: tokens,
      notification: { title, body, icon: icon || '/logo-192.png', badge: badge || '/badge-72.png', tag: tag || 'chat' },
      data: { title, body, url: url || '/chat-list.html', icon, badge, tag }
    };

    const r = await fetch(FCM_ENDPOINT, {
      method:'POST',
      headers:{
        'Authorization': `key=${process.env.FCM_SERVER_KEY}`, // Netlify env var
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const txt = await r.text();
    return { statusCode: r.status, body: txt };
  } catch (e) {
    return { statusCode: 500, body: e.message || 'Error' };
  }
};
