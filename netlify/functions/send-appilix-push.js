// netlify/functions/send-appilix-push.js
export async function handler(event) {
  const cors = {
    'Access-Control-Allow-Origin': event.headers.origin || 'https://bechobazaar.com',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }

  try {
    const { user_identity, title, message, open_link_url } = JSON.parse(event.body || '{}');

    const appKey = process.env.APPILIX_APP_KEY;
    const apiKey = process.env.APPILIX_API_KEY;
    if (!appKey || !apiKey) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ ok:false, error:'Missing Appilix keys' }) };
    }

    const form = new URLSearchParams();
    form.set('app_key', appKey);
    form.set('api_key', apiKey);
    form.set('notification_title', title || 'Notification');
    form.set('notification_body', message || '');
    if (user_identity) form.set('user_identity', user_identity);   // targeted
    if (open_link_url) form.set('open_link_url', open_link_url);

    const resp = await fetch('https://appilix.com/api/push-notification', {
      method:'POST',
      headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
      body: form.toString()
    });

    const text = await resp.text(); // Appilix returns JSON(string)
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok:true, result:{ status: resp.status, text } }) };
  } catch (err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ ok:false, error:String(err?.message||err) }) };
  }
}
