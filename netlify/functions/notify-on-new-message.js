// /api/notify-on-new-message.js
// Node 16+
// ENV needs: GOOGLE_APPLICATION_CREDENTIALS (if using Admin SDK from server),
// or use Firebase Admin init with service account json content.

const admin = require('firebase-admin');
const fetch = require('node-fetch');

if (!admin.apps.length) {
  admin.initializeApp({
    // If running on GCP/Cloud Functions, default creds will work.
    // For Netlify/Vercel, use service account JSON from env safely (not shown here).
  });
}
const db = admin.firestore();

// Optional: Appilix push config
const APPILIX_PUSH_URL = process.env.APPILIX_PUSH_URL || ''; // e.g., 'https://push.appilix.com/api/v1/notify'
const APPILIX_KEY      = process.env.APPILIX_KEY || '';

async function getRecipients(chatId, excludeUid) {
  // Example chat schema assumption:
  // chats/{chatId}: { members: [uid1, uid2, ...] }
  const c = await db.collection('chats').doc(chatId).get();
  if (!c.exists) return [];
  const members = Array.isArray(c.data().members) ? c.data().members : [];
  return members.filter(uid => uid && uid !== excludeUid);
}

async function getMessage(chatId, messageId) {
  const ref = db.collection('chats').doc(chatId).collection('messages').doc(messageId);
  const snap = await ref.get();
  return snap.exists ? ({ id: snap.id, ...snap.data() }) : null;
}

async function getUserTokens(uid) {
  const tokens = [];
  const endpoints = [];
  const tokSnap = await db.collection('users').doc(uid).collection('fcmTokens').get();
  tokSnap.forEach(d => tokens.push(d.id));
  const endSnap = await db.collection('users').doc(uid).collection('pushEndpoints').get();
  endSnap.forEach(d => endpoints.push({ id: d.id, ...d.data() }));
  return { tokens, endpoints };
}

async function sendFCM(tokens, payload) {
  if (!tokens.length) return { ok: true, count: 0 };
  // Using Admin SDK sendToDevice for v1 legacy compatibility
  const res = await admin.messaging().sendToDevice(tokens, payload, {
    priority: 'high',
  });
  return { ok: true, res };
}

async function sendAppilix(endpoints, title, body, url) {
  if (!APPILIX_PUSH_URL || !APPILIX_KEY) return { ok: true };
  const nativeTargets = endpoints.filter(e => (e.type || '').startsWith('appilix'));
  if (!nativeTargets.length) return { ok: true };
  try{
    const payload = {
      title, body, url,
      endpoints: nativeTargets.map(n => n.token || n.id)
    };
    const r = await fetch(APPILIX_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': APPILIX_KEY },
      body: JSON.stringify(payload)
    });
    return { ok: r.ok, status: r.status };
  }catch(e){
    return { ok: false, error: String(e) };
  }
}

function makeNotificationPayload({ title, body, url, tag }) {
  // Data-only payload so SW handle kare (reliable on background)
  return {
    data: {
      title: title || 'New message',
      body:  body  || 'You have a new message',
      url:   url   || '/chat-list.html',
      tag:   tag   || 'chat_inbox'
    }
  };
}

// ---- HTTP handler (Express style) ----
module.exports = async function handler(req, res) {
  try{
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const auth = req.headers.authorization || '';
    const m    = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).send('Missing bearer token');
    let decoded;
    try{
      decoded = await admin.auth().verifyIdToken(m[1]);
    }catch(e){
      return res.status(401).send('Invalid token');
    }

    const { chatId, messageId } = req.body || {};
    if (!chatId || !messageId) return res.status(400).send('chatId and messageId required');

    const msg = await getMessage(chatId, messageId);
    if (!msg) return res.status(404).send('message not found');

    const senderUid = msg.senderId || decoded.uid;
    const recips = await getRecipients(chatId, senderUid);
    if (!recips.length) return res.json({ ok: true, sent: 0 });

    // Prepare notification fields
    const title = msg.senderName ? `${msg.senderName}` : 'New message';
    const body  = msg.text ? msg.text.slice(0, 80) : 'Tap to view';
    const url   = `/chat.html?chatId=${encodeURIComponent(chatId)}`;
    const tag   = `chat_${chatId}`;

    const payload = makeNotificationPayload({ title, body, url, tag });

    let totalTokens = [];
    let allEndpoints = [];
    for (const uid of recips) {
      const { tokens, endpoints } = await getUserTokens(uid);
      totalTokens = totalTokens.concat(tokens);
      allEndpoints = allEndpoints.concat(endpoints || []);
    }

    // FCM web push
    const fcmRes = await sendFCM(totalTokens, payload);
    // Appilix native push (optional)
    const appRes = await sendAppilix(allEndpoints, title, body, url);

    return res.json({
      ok: true,
      recipients: recips.length,
      fcmTokens: totalTokens.length,
      fcmResult: fcmRes,
      appilix: appRes
    });
  }catch(e){
    console.error('notify error', e);
    return res.status(500).send('Internal error');
  }
};
