// netlify/functions/send-appilix-push.js
// Node 18+ (Netlify has global fetch)
const allowedMethods = ['POST'];

async function sendPushToAppilix({ appKey, apiKey, title, body, user_identity, open_link_url }) {
  const url = 'https://appilix.com/api/push-notification';
  const form = new URLSearchParams();
  form.set('app_key', appKey);
  form.set('api_key', apiKey);
  form.set('notification_title', title || 'New message');
  form.set('notification_body', body || '');
  if (user_identity) form.set('user_identity', user_identity);
  if (open_link_url) form.set('open_link_url', open_link_url);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });

  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`Appilix API failed: ${res.status} ${text}`);
  return { status: res.status, text };
}

exports.handler = async function (event) {
  try {
    if (!allowedMethods.includes(event.httpMethod)) {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const payload = JSON.parse(event.body || '{}');

    // Read keys from env — set these in Netlify dashboard (BUILD & DEPLOY > Environment)
    const APPILIX_APP_KEY = process.env.APPILIX_APP_KEY;
    const APPILIX_API_KEY = process.env.APPILIX_API_KEY;

    if (!APPILIX_APP_KEY || !APPILIX_API_KEY) {
      return { statusCode: 500, body: 'Missing Appilix keys in environment' };
    }

    // Required fields from caller
    const { title, message, user_identity, open_link_url } = payload;
    if (!message) return { statusCode: 400, body: 'missing message' };

    // Compose notification title & body (customize as needed)
    const notificationTitle = title || 'New message received';
    const notificationBody = message.length > 120 ? message.slice(0, 117) + '...' : message;

    const result = await sendPushToAppilix({
      appKey: APPILIX_APP_KEY,
      apiKey: APPILIX_API_KEY,
      title: notificationTitle,
      body: notificationBody,
      user_identity,
      open_link_url
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, result })
    };
  } catch (err) {
    console.error('send-appilix-push error:', err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
