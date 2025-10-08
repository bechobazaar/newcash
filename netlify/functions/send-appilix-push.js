// netlify/functions/send-appilix-push.js
// Node 18+

const ENDPOINT = 'https://appilix.com/api/push-notification';

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
  };
}
const resJSON = (code, body) => ({ statusCode: code, headers: cors(), body: JSON.stringify(body) });

function readKey(nameRaw, nameB64) {
  const raw = (process.env[nameRaw] || '').trim();
  if (raw) return raw;
  const b64 = (process.env[nameB64] || '').trim();
  return b64 ? Buffer.from(b64, 'base64').toString('utf8').trim() : '';
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors() };
  if (event.httpMethod !== 'POST') return resJSON(405, { ok: false, error: 'method-not-allowed' });

  const APP_KEY = readKey('APPILIX_APP_KEY', 'APPILIX_APP_KEY_B64');
  const API_KEY = readKey('APPILIX_API_KEY', 'APPILIX_API_KEY_B64');
  if (!APP_KEY || !API_KEY) return resJSON(500, { ok: false, error: 'Missing Appilix keys' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

  const { user_identity, title, message, open_link_url } = body;

  const form = new URLSearchParams();
  form.set('app_key', APP_KEY);
  form.set('api_key', API_KEY);
  if (user_identity) form.set('user_identity', user_identity);
  form.set('notification_title', title || 'Notification');
  form.set('notification_body', message || '');
  if (open_link_url) form.set('open_link_url', open_link_url);

  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });

  const text = await r.text(); // Appilix JSON string return karta hai
  return resJSON(200, { ok: true, result: { status: r.status, text } });
};
