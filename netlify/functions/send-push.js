// /.netlify/functions/send-push
// Uses FCM legacy HTTP API with SERVER_KEY (env var) — client key kabhi expose mat karna.
const fetch = (...a) => import('node-fetch').then(({default: f}) => f(...a));

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const { tokens = [], title, body, url = '/', icon, badge, tag = 'bechobazaar', data = {} } = JSON.parse(event.body || '{}');

    if (!Array.isArray(tokens) || tokens.length === 0) {
      return { statusCode: 400, body: 'No tokens' };
    }

    const SERVER_KEY = process.env.FCM_SERVER_KEY;
    if (!SERVER_KEY) {
      return { statusCode: 500, body: 'FCM_SERVER_KEY missing' };
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
      data: {
        ...data,
        url // SW will open this
      },
      webpush: {
        fcm_options: { link: url }
      }
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
    return { statusCode: res.ok ? 200 : 500, body: JSON.stringify(json) };
  } catch (e) {
    return { statusCode: 500, body: e.message || 'Error' };
  }
};
