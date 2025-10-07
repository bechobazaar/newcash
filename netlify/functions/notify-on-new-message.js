// netlify/functions/notify-on-new-message.js
const { initAdminFromB64 } = require('./firebaseAdmin');
const admin = initAdminFromB64();
const db = admin.firestore();

// Appilix API helper (user_identity targeting)
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
    headers: { 'Content-Type':'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  const text = await res.text().catch(()=> '');
  if (!res.ok) throw new Error(`Appilix API failed: ${res.status} ${text}`);
  return { ok:true, status:res.status };
}

const ALLOW_ORIGIN = 'https://bechobazaar.com';

function cors() {
  return {
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

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
async function fcmTokensOf(uid){
  const tokens = [];
  const snap = await db.collection('users').doc(uid).collection('fcmTokens').get();
  snap.forEach(d => tokens.push(d.id));
  return tokens;
}
async function sendFCM(allTokens, payload) {
  if (!allTokens.length) return { ok:true, count:0 };
  const res = await admin.messaging().sendToDevice(allTokens, payload, { priority:'high' });
  return { ok:true, res };
}
function makeDataPayload({ title, body, url, tag }) {
  // data-only so that SW shows even in background reliably
  return { data: { title, body, url, tag } };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors(), body: '' };
  }
  try {
    if (event.httpMethod !== 'POST')
      return { statusCode: 405, headers: cors(), body: 'Method Not Allowed' };

    const authH = (event.headers.authorization || event.headers.Authorization || '');
    const m = authH.match(/^Bearer\s+(.+)$/i);
    if (!m) return { statusCode: 401, headers: cors(), body: 'Missing bearer token' };

    let decoded;
    try { decoded = await admin.auth().verifyIdToken(m[1]); }
    catch (e) {
      return { statusCode: 401, headers: cors(), body: `Invalid token: ${e.message || ''}` };
    }

    const { chatId, messageId } = JSON.parse(event.body || '{}');
    if (!chatId || !messageId)
      return { statusCode: 400, headers: cors(), body: 'chatId and messageId required' };

    const msg = await getMessage(chatId, messageId);
    if (!msg) return { statusCode: 404, headers: cors(), body: 'message not found' };

    const senderUid = msg.senderId || decoded.uid;
    const recipients = await getRecipients(chatId, senderUid);
    if (!recipients.length)
      return { statusCode: 200, headers: cors(), body: JSON.stringify({ ok:true, sent:0 }) };

    // Compose notification content (OLX-like)
    const senderName = msg.senderName || 'New message';
    const bodyText   = (msg.text || 'Tap to view').slice(0, 80);
    const openUrl    = `/chat/${encodeURIComponent(chatId)}`;  // pretty URL
    const tag        = `chat_${chatId}`;

    // FCM collect
    let fcmAll = [];
    for (const uid of recipients) {
      const t = await fcmTokensOf(uid);
      fcmAll = fcmAll.concat(t);
    }
    const fcmPayload = makeDataPayload({ title: `New message from ${senderName}`, body: bodyText, url: openUrl, tag });
    const fcmRes = await sendFCM(fcmAll, fcmPayload);

    // Appilix per-user via user_identity = uid
    let appilixStatus = { ok:true, count:0, results:[] };
    const APP_KEY = process.env.APPILIX_APP_KEY;
    const API_KEY = process.env.APPILIX_API_KEY;
    if (APP_KEY && API_KEY) {
      const absUrl = new URL(openUrl, 'https://bechobazaar.com').href;
      for (const uid of recipients) {
        try {
          const r = await sendAppilixPush({
            appKey: APP_KEY,
            apiKey: API_KEY,
            title: `New message from ${senderName}`,
            body: bodyText,
            user_identity: uid,          // 🔑 identity set in app at login
            open_link_url: absUrl
          });
          appilixStatus.results.push({ uid, ok:true });
        } catch (e) {
          appilixStatus.results.push({ uid, ok:false, error: String(e) });
        }
      }
      appilixStatus.count = appilixStatus.results.length;
    }

    return {
      statusCode: 200,
      headers: cors(),
      body: JSON.stringify({
        ok: true,
        recipients: recipients.length,
        fcmTokens: fcmAll.length,
        fcmResult: fcmRes,
        appilix: appilixStatus
      })
    };
  } catch (e) {
    console.error('notify error', e);
    return { statusCode: 500, headers: cors(), body: 'Internal error' };
  }
};
