// netlify/functions/notify-on-new-message.js (Node 18)
// ENV required: FIREBASE_SERVICE_ACCOUNT_B64, APPILIX_APP_KEY, APPILIX_API_KEY
// Optional: ALLOW_ORIGINS (CSV) e.g. "https://bechobazaar.com,https://bechobazaar.netlify.app"

const admin = require('firebase-admin');

function initAdmin(){
  if (admin.apps.length) return;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 missing');
  const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  admin.initializeApp({ credential: admin.credential.cert(json) });
}
initAdmin();

const db = admin.firestore();

function cors(res){
  const allow = (process.env.ALLOW_ORIGINS || '*');
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
}

async function getRecipients(chatId, excludeUid){
  const doc = await db.collection('chats').doc(chatId).get();
  if (!doc.exists) return [];
  const members = Array.isArray(doc.data().members) ? doc.data().members : [];
  return members.filter(u => u && u !== excludeUid);
}

async function getUserTokens(uid){
  const tokens = [];
  const endpoints = [];
  const tokSnap = await db.collection('users').doc(uid).collection('fcmTokens').get();
  tokSnap.forEach(d => tokens.push(d.id));
  const endSnap = await db.collection('users').doc(uid).collection('pushEndpoints').get();
  endSnap.forEach(d => endpoints.push({ id:d.id, ...d.data() }));
  return { tokens, endpoints };
}

// Appilix API (form-urlencoded)
async function sendAppilixPush({ appKey, apiKey, title, body, user_identity, open_link_url }){
  const url  = 'https://appilix.com/api/push-notification';
  const form = new URLSearchParams();
  form.set('app_key', appKey);
  form.set('api_key', apiKey);
  form.set('notification_title', title || 'Notification');
  form.set('notification_body',  body  || '');
  if (user_identity) form.set('user_identity', user_identity);
  if (open_link_url) form.set('open_link_url', open_link_url);

  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: form.toString() });
  const text = await r.text().catch(()=> '');
  if (!r.ok) return { ok:false, status:r.status, text };
  return { ok:true, status:r.status, text };
}

function makeDataPayload({ title, body, url, tag }){
  return {
    data: {
      title: title || 'New message',
      body:  body  || 'You have a new message',
      url:   url   || '/chat-list',
      tag:   tag   || 'chat_inbox'
    }
  };
}

exports.handler = async (event, context) => {
  const resHeaders = {};
  try{
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 200, headers: {
        'Access-Control-Allow-Origin': process.env.ALLOW_ORIGINS || '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      }};
    }

    const headers = event.headers || {};
    const auth = headers.authorization || headers.Authorization || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      return { statusCode: 401, headers: {'Access-Control-Allow-Origin': process.env.ALLOW_ORIGINS || '*'}, body: 'Missing bearer token' };
    }

    const decoded = await admin.auth().verifyIdToken(m[1]).catch(()=>null);
    if (!decoded) {
      return { statusCode: 401, headers: {'Access-Control-Allow-Origin': process.env.ALLOW_ORIGINS || '*'}, body: 'Invalid token' };
    }

    const body = JSON.parse(event.body || '{}');
    const { chatId, messageId } = body;
    if (!chatId || !messageId) {
      return { statusCode: 400, headers: {'Access-Control-Allow-Origin': process.env.ALLOW_ORIGINS || '*'}, body: 'chatId and messageId required' };
    }

    const msgSnap = await db.collection('chats').doc(chatId).collection('messages').doc(messageId).get();
    if (!msgSnap.exists) {
      return { statusCode: 404, headers: {'Access-Control-Allow-Origin': process.env.ALLOW_ORIGINS || '*'}, body: 'message not found' };
    }
    const msg = { id: msgSnap.id, ...msgSnap.data() };
    const senderUid = msg.senderId || decoded.uid;

    const recips = await getRecipients(chatId, senderUid);
    if (!recips.length) {
      return { statusCode: 200, headers: {'Access-Control-Allow-Origin': process.env.ALLOW_ORIGINS || '*'}, body: JSON.stringify({ ok:true, sent:0 }) };
    }

    // collect tokens and (optional) appilix identities
    let fcmTokens = [];
    let identities = [];
    for (const uid of recips){
      const { tokens, endpoints } = await getUserTokens(uid);
      fcmTokens = fcmTokens.concat(tokens);
      // If you use Appilix "user_identity" = uid (recommended)
      identities.push(uid);
    }

    const title = msg.senderName ? `${msg.senderName}` : 'New message';
    const bodyText = msg.text ? String(msg.text).slice(0,80) : 'Tap to view';
    const deepLink = `/chat?chatId=${encodeURIComponent(chatId)}`;
    const tag  = `chat_${chatId}`;
    const payload = makeDataPayload({ title, body: bodyText, url: deepLink, tag });

    // FCM (web push)
    let fcmResp = null;
    if (fcmTokens.length){
      fcmResp = await admin.messaging().sendMulticast({
        tokens: fcmTokens,
        data: payload.data
      });
    }

    // Appilix push (per user_identity)
    let appResp = null;
    if (process.env.APPILIX_APP_KEY && process.env.APPILIX_API_KEY) {
      // You can call once per uid, here simple single call with sender info
      appResp = await sendAppilixPush({
        appKey: process.env.APPILIX_APP_KEY,
        apiKey: process.env.APPILIX_API_KEY,
        title,
        body: bodyText,
        user_identity: identities[0],     // or loop over identities to send individually
        open_link_url: deepLink
      });
    }

    return {
      statusCode: 200,
      headers: {'Access-Control-Allow-Origin': process.env.ALLOW_ORIGINS || '*'},
      body: JSON.stringify({
        ok: true,
        recipients: recips.length,
        fcmTokens: fcmTokens.length,
        fcm: fcmResp,
        appilix: appResp
      })
    };
  }catch(e){
    return {
      statusCode: 500,
      headers: {'Access-Control-Allow-Origin': process.env.ALLOW_ORIGINS || '*'},
      body: 'Internal error: ' + (e?.message || String(e))
    };
  }
};
