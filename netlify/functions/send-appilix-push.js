// netlify/functions/send-appilix-push.js
// Node 18+ global fetch

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return resp(204, null);
    }

    const body = JSON.parse(event.body || '{}');
    const { user_identity, title, message, open_link_url } = body;

    if (!user_identity) {
      return resp(400, { ok:false, error:'missing_user_identity' }); // no broadcast
    }

    const form = new URLSearchParams();
    form.set('app_key', process.env.APPILIX_APP_KEY);
    form.set('api_key', process.env.APPILIX_API_KEY);
    form.set('notification_title', title || 'Notification');
    form.set('notification_body', message || '');
    form.set('user_identity', user_identity);
    if (open_link_url) form.set('open_link_url', open_link_url);

    const r = await fetch('https://appilix.com/api/push-notification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });

    const text = await r.text();
    // Appilix string JSON deta hai: {"status":"true"} ya {"status":"false","msg":"..."}
    let parsed = {};
    try { parsed = JSON.parse(text); } catch {}
    const ok = parsed?.status === 'true';

    return resp(200, { ok, status: r.status, text });
  } catch (e) {
    return resp(500, { ok:false, error: String(e) });
  }
};

function resp(code, body) {
  return {
    statusCode: code,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Content-Type': 'application/json',
    },
    body: body==null ? '' : JSON.stringify(body),
  };
}
