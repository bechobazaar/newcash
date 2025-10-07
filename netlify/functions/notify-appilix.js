// netlify/functions/notify-appilix.js (Node 18+)
const admin = require('firebase-admin');

(function init(){
  if (admin.apps.length) return;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64; // base64 of service-account JSON
  if (!b64) throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 missing');
  const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  admin.initializeApp({ credential: admin.credential.cert(json) });
})();
const db = admin.firestore();

function cors() {
  return {
    'Access-Control-Allow-Origin': process.env.ALLOW_ORIGINS || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}

async function sendAppilixPush({ appKey, apiKey, title, body, user_identity, open_link_url }){
  const url = 'https://appilix.com/api/push-notification';
  const form = new URLSearchParams();
  form.set('app_key', appKey);
  form.set('api_key', apiKey);
  form.set('notification_title', title || 'Notification');
  form.set('notification_body',  body  || '');
  if (user_identity) form.set('user_identity', user_identity);
  if (open_link_url) form.set('open_link_url', open_link_url);

  const r = await fetch(url, {
    method:'POST',
    headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  const text = await r.text().catch(()=> '');
  return { ok:r.ok, status:r.status, text };
}

async function getRecipients(chatId, excludeUid){
  const s = await db.collection('chats').doc(chatId).get();
  if (!s.exists) return [];
  const arr = Array.isArray(s.data().members) ? s.data().members : (s.data().users || []);
  return arr.filter(uid => uid && uid !== excludeUid);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers:cors(), body:'' };

  try{
    const authH = event.headers.authorization || event.headers.Authorization || '';
    const m = authH.match(/^Bearer\s+(.+)$/i);
    if (!m) return { statusCode:401, headers:cors(), body:'Missing bearer token' };
    const decoded = await admin.auth().verifyIdToken(m[1]).catch(()=>null);
    if (!decoded) return { statusCode:401, headers:cors(), body:'Invalid token' };

    const { chatId, messageId } = JSON.parse(event.body || '{}');
    if (!chatId || !messageId) return { statusCode:400, headers:cors(), body:'chatId and messageId required' };

    const msgSnap = await db.collection('chats').doc(chatId).collection('messages').doc(messageId).get();
    if (!msgSnap.exists) return { statusCode:404, headers:cors(), body:'message not found' };
    const msg = msgSnap.data() || {};
    const senderUid = msg.senderId || decoded.uid;

    const recips = await getRecipients(chatId, senderUid);
    if (!recips.length) return { statusCode:200, headers:cors(), body: JSON.stringify({ ok:true, recipients:0 }) };

    const appKey = process.env.APPILIX_APP_KEY;
    const apiKey = process.env.APPILIX_API_KEY;
    if (!appKey || !apiKey) return { statusCode:500, headers:cors(), body:'Appilix keys missing' };

    const base = process.env.APP_BASE_URL || 'https://bechobazaar.com';
    const link = `${base}/chat?chatId=${encodeURIComponent(chatId)}`;
    const title = msg.senderName || 'New message';
    const body  = msg.text ? String(msg.text).slice(0,80) : 'Tap to view';

    const results = [];
    for (const uid of recips) {
      results.push({
        uid,
        ...(await sendAppilixPush({ appKey, apiKey, title, body, user_identity: uid, open_link_url: link }))
      });
    }
    return { statusCode:200, headers:cors(), body: JSON.stringify({ ok:true, recipients:recips.length, appilix:results }) };
  }catch(e){
    return { statusCode:500, headers:cors(), body:'Internal error: '+(e.message||String(e)) };
  }
};
