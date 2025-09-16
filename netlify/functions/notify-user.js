// /.netlify/functions/notify-user.js
const admin = require('firebase-admin');
const webpush = require('web-push');

function readServiceAccount() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_B64');
  const obj = JSON.parse(Buffer.from(b64.trim(), 'base64').toString('utf8'));
  if (obj.private_key) obj.private_key = obj.private_key.replace(/\\n/g, '\n');
  return obj;
}
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(readServiceAccount()) });

const db = admin.firestore();

// VAPID (for WebPush fallback)
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:admin@bechobazaar.com', VAPID_PUBLIC, VAPID_PRIVATE);
}

const ALLOWED_ORIGINS = ['https://bechobazaar.com', 'https://www.bechobazaar.com', process.env.APP_BASE_URL].filter(Boolean);
const pickOrigin = (e) => {
  const h = e.headers || {};
  const o = h.origin || h.Origin || (h.host ? `https://${h.host}` : '');
  return ALLOWED_ORIGINS.includes(o) ? o : (process.env.APP_BASE_URL || ALLOWED_ORIGINS[0] || '').replace(/\/$/, '');
};

async function collectEndpoints(uid){
  const snap = await db.collection('users').doc(uid).collection('pushEndpoints').get();
  const res = { fcm: [], webpush: [] };
  snap.forEach(d => {
    const x = d.data() || {};
    if (x.type === 'fcm_web')     res.fcm.push(x.token);
    else if (x.type === 'native') res.fcm.push(x.token);            // native FCM token
    else if (x.type === 'webpush' && x.sub) res.webpush.push(JSON.parse(x.sub));
  });
  return res;
}

exports.handler = async (event) => {
  const ORIGIN = pickOrigin(event);
  const cors = {
    'Access-Control-Allow-Origin': ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  try {
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

    // Auth: either Firebase ID token or admin secret
    const hdr = event.headers || {};
    const adminSecret = process.env.ADMIN_PUSH_SECRET;
    let okAuth = false;
    if (adminSecret && hdr['x-admin-secret'] === adminSecret) okAuth = true;
    if (!okAuth) {
      const auth = hdr.authorization || hdr.Authorization || '';
      if (!auth.startsWith('Bearer ')) return { statusCode: 401, headers: cors, body: 'Unauthorized' };
      await admin.auth().verifyIdToken(auth.slice(7));
      okAuth = true;
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: cors, body: 'Invalid JSON' }; }
    let { uid, title, body: msgBody, url = '/', tag = 'general_notice', data = {} } = body;
    if (!uid || !title) return { statusCode: 400, headers: cors, body: 'uid and title required' };

    const base = (ORIGIN || process.env.APP_BASE_URL || 'https://bechobazaar.com').replace(/\/$/, '');
    if (!/^https?:\/\//.test(url)) url = `${base}${url.startsWith('/') ? '' : '/'}${url}`;

    // Collect all endpoints
    const endpoints = await collectEndpoints(uid);
    let sentFcm = 0, failedFcm = 0, sentWebPush = 0, failedWebPush = 0;

    // ------ FCM (web + native) ------
    if (endpoints.fcm.length){
      const fcmMsg = {
        tokens: endpoints.fcm,
        notification: { title: String(title), body: String(msgBody || '') },
        data: { title:String(title), body:String(msgBody||''), url, tag:String(tag), ...Object.fromEntries(Object.entries(data).map(([k,v])=>[k,String(v)])) },
        webpush: {
          fcmOptions: { link: url },
          headers: { Urgency:'high', TTL:'600' },
          notification: { title:String(title), body:String(msgBody||''), icon:'/icons/icon-192.png', badge:'/icons/badge-72.png', tag:String(tag), renotify:true }
        },
        android: { priority:'high' },
        apns: { headers: { 'apns-priority':'10' } }
      };
      const res = await admin.messaging().sendEachForMulticast(fcmMsg);
      sentFcm += res.successCount; failedFcm += res.failureCount;

      // Clean invalid tokens
      for (let i=0;i<res.responses.length;i++){
        const r = res.responses[i];
        if (!r.success){
          const tok = fcmMsg.tokens[i];
          const code = r.error?.code || '';
          if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')){
            // delete any pushEndpoints with this token
            const pe = await db.collection('users').doc(uid).collection('pushEndpoints')
              .where('token','==',tok).get();
            pe.forEach(d=>d.ref.delete().catch(()=>{}));
          }
        }
      }
    }

    // ------ WebPush (fallback) ------
    if (VAPID_PUBLIC && VAPID_PRIVATE && endpoints.webpush.length){
      const payload = JSON.stringify({ title, body: msgBody || '', url, tag, ...data });
      await Promise.all(endpoints.webpush.map(async (sub) => {
        try{ await webpush.sendNotification(sub, payload); sentWebPush++; }
        catch(e){ failedWebPush++; /* optionally clean gone subs */ }
      }));
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify({
      fcm: { sent: sentFcm, failed: failedFcm },
      webpush: { sent: sentWebPush, failed: failedWebPush }
    })};
  } catch (e) {
    console.error('notify-user error', e);
    return { statusCode: 500, headers: cors, body: 'Internal Server Error' };
  }
};
