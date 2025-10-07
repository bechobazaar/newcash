// netlify/functions/notify-on-new-message.js
const { initAdminFromB64 } = require('./firebaseAdmin');
const admin = initAdminFromB64();
const db = admin.firestore();

// Node18 → global fetch available
const { sendAppilixPush } = (() => {
  try { return require('./sendAppilixPush'); } catch { return { sendAppilixPush: null }; }
})();

const ALLOW_ORIGIN = 'https://bechobazaar.com';

function cors() {
  return {
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

// ---- helpers ----
async function getRecipients(chatId, excludeUid) {
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
  const res = await admin.messaging().sendToDevice(tokens, payload, { priority: 'high' });
  return { ok: true, res };
}
function makeNotificationPayload({ title, body, url, tag }) {
  return {
    data: {
      title: title || 'New message',
      body:  body  || 'You have a new message',
      url:   url   || '/chat-list.html',
      tag:   tag   || 'chat_inbox'
    }
  };
}
async function sendAppilix(endpoints, title, body, url) {
  if (!sendAppilixPush) return { ok: true };
  const appKey = process.env.APPILIX_APP_KEY;
  const apiKey = process.env.APPILIX_API_KEY;
  if (!appKey || !apiKey) return { ok: true };

  const nativeTargets = endpoints.filter(e => (e.type || '').startsWith('appilix'));
  if (!nativeTargets.length) return { ok: true };

  const absUrl = new URL(url, 'https://bechobazaar.com').href;
  const results = [];
  for (const e of nativeTargets) {
    const user_identity = e.token || e.id;
    try {
      results.push(await sendAppilixPush({ appKey, apiKey, title, body, user_identity, open_link_url: absUrl }));
    } catch (err) {
      results.push({ ok:false, error:String(err) });
    }
  }
  return { ok: true, count: results.length, results };
}

// ---- Netlify handler ----
exports.handler = async (event) => {
  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(), body: '' };
  }

  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers: cors(), body: 'Method Not Allowed' };
    }

    const authH = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
    const m = authH.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      return { statusCode: 401, headers: cors(), body: 'Missing bearer token' };
    }

    // Verify Firebase ID token (now tied to your SA project)
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(m[1], false);
    } catch (e) {
      console.error('[AUTH] verifyIdToken error', { code: e.code, message: e.message });
      return { statusCode: 401, headers: cors(), body: `Invalid token (${e.code || 'unknown'}): ${e.message || ''}` };
    }

    const body = JSON.parse(event.body || '{}');
    const { chatId, messageId } = body;
    if (!chatId || !messageId) {
      return { statusCode: 400, headers: cors(), body: 'chatId and messageId required' };
    }

    const msg = await getMessage(chatId, messageId);
    if (!msg) return { statusCode: 404, headers: cors(), body: 'message not found' };

    const senderUid = msg.senderId || decoded.uid;
    const recips = await getRecipients(chatId, senderUid);
    if (!recips.length) {
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok: true, sent: 0 }) };
    }

    const title = msg.senderName ? `${msg.senderName}` : 'New message';
    const bodyTxt = msg.text ? msg.text.slice(0, 80) : 'Tap to view';
    const url  = `/chat.html?chatId=${encodeURIComponent(chatId)}`;
    const tag  = `chat_${chatId}`;
    const payload = makeNotificationPayload({ title, body: bodyTxt, url, tag });

    let totalTokens = [];
    let allEndpoints = [];
    for (const uid of recips) {
      const { tokens, endpoints } = await getUserTokens(uid);
      totalTokens = totalTokens.concat(tokens);
      allEndpoints = allEndpoints.concat(endpoints || []);
    }

    const fcmRes = await sendFCM(totalTokens, payload);
    const appRes = await sendAppilix(allEndpoints, title, bodyTxt, url);

    return {
      statusCode: 200,
      headers: cors(),
      body: JSON.stringify({
        ok: true,
        recipients: recips.length,
        fcmTokens: totalTokens.length,
        fcmResult: fcmRes,
        appilix: appRes
      })
    };
  } catch (e) {
    console.error('notify error', e);
    return { statusCode: 500, headers: cors(), body: 'Internal error' };
  }
};
