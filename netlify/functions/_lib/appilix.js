// netlify/functions/_lib/appilix.js

// Netlify (Node 18+) par global fetch available hota hai.
// Agar tum Node 16 par ho to node-fetch add karke import karna padega.
// const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

async function sendAppilixPush({ appKey, apiKey, title, body, user_identity, open_link_url }) {
  const url = 'https://appilix.com/api/push-notification';
  const params = new URLSearchParams();
  params.set('app_key', appKey);
  params.set('api_key', apiKey);
  params.set('notification_title', title || 'Notification');
  params.set('notification_body',  body  || '');
  if (user_identity) params.set('user_identity', user_identity);
  if (open_link_url) params.set('open_link_url', open_link_url);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  let json = {};
  try { json = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error('Appilix API failed: ' + JSON.stringify(json));
  return json;
}

module.exports = { sendAppilixPush };
