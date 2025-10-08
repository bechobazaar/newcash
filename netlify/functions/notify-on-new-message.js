// netlify/functions/notify-on-new-message.js
// Node 18+

const fetch = global.fetch; // node18
const admin = require('firebase-admin');

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
  };
}
const resJSON = (code, body) => ({ statusCode: code, headers: cors(), body: JSON.stringify(body) });

function initAdmin() {
  if (admin.apps.length) return;
  // SERVICE ACCOUNT ko Base64 JSON me env me rakha ho to:
  const b64 = (process.env.FB_SERVICE_ACCOUNT_B64 || '').trim();
  if (b64) {
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    admin.initializeApp({ credential: admin.credential.cert(json) });
  } else {
    // ya default creds
    admin.initializeApp();
  }
}
initAdmin();
const db = admin.firestore();

const SEND_APPILIX_URL =
  process.env.SEND_APPILIX_URL || 'https://bechobazaar.netlify.app/.netlify/functions/send-appilix-push';

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors() };
  if (event.httpMethod !== 'POST') return resJSON(405, { ok: false, error: 'method-not-allowed' });

  // (optional) verify ID token
  const authz = event.headers.authorization || '';
  const idToken = (authz.split(' ')[1] || '').trim();
  try {
    if (idToken) await admin.auth().verifyIdToken(idToken);
  } catch {
    // not fatal for push; ignore or enforce as you like
  }

  let payload = {};
  try { payload = JSON.parse(event.body || '{}'); } catch {}
  const { chatId, messageId } = payload;
  if (!chatId || !messageId) return resJSON(400, { ok: false, error: 'chatId/messageId required' });

  const chatRef = db.collection('chats').doc(chatId);
  const msgRef = chatRef.collection('messages').doc(messageId);

  const [chatSnap, msgSnap] = await Promise.all([chatRef.get(), msgRef.get()]);
  if (!chatSnap.exists || !msgSnap.exists) return resJSON(404, { ok: false, error: 'not-found' });

  const chat = chatSnap.data() || {};
  const msg = msgSnap.data() || {};

  const sender = msg.senderId;
  const users = Array.isArray(chat.users) ? chat.users : [];
  const recipients = users.filter((u) => u && u !== sender);

  if (!recipients.length) return resJSON(200, { ok: true, skipped: 'no-recipient' });

  const preview =
    (msg.text && String(msg.text).trim()) ||
    (Array.isArray(msg.imageUrls) && msg.imageUrls.length ? 'Sent a photo' : 'New message');
  const openLink = `https://bechobazaar.com/chat-list?open_conversation=${encodeURIComponent(chatId)}`;

  // Appilix targeted push to each recipient
  const calls = recipients.map((uid) =>
    fetch(SEND_APPILIX_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_identity: uid,
        title: 'New message',
        message: preview,
        open_link_url: openLink,
      }),
    })
      .then((r) => r.text())
      .catch((e) => `ERR:${e}`)
  );

  const results = await Promise.all(calls);

  // Mark delivered (server-side)
  await msgRef.set({ delivered: true, status: 'delivered' }, { merge: true });

  // (Optional) FCM fallback YAHI pe karo agar Appilix fail detect ho:
  // const failed = results.some(t => /"status"\s*:\s*"false"/i.test(t));
  // if (failed) {  <-- yahan apna FCM logic daal do  }

  return resJSON(200, { ok: true, recipients, results });
};
