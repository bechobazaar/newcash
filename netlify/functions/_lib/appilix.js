async function sendAppilixPush({ appKey, apiKey, title, body, user_identity, open_link_url }) {
  const url = 'https://appilix.com/api/push-notification';
  const form = new URLSearchParams();
  form.set('app_key', appKey);
  form.set('api_key', apiKey);
  form.set('notification_title', title || 'Notification');
  form.set('notification_body',  body  || '');
  if (user_identity) form.set('user_identity', user_identity);
  if (open_link_url) form.set('open_link_url', open_link_url);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  const text = await res.text().catch(()=> '');
  if (!res.ok) throw new Error(`Appilix API failed: ${res.status} ${text}`);
  return { ok:true, status:res.status, text };
}
module.exports = { sendAppilixPush };
