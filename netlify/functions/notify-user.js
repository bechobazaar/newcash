// /.netlify/functions/notify-user.js
const admin = require('firebase-admin');

function initAdmin() {
  if (!admin.apps.length) {
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    const obj = JSON.parse(Buffer.from(b64.trim(), 'base64').toString('utf8'));
    if (obj.private_key) obj.private_key = obj.private_key.replace(/\\n/g, '\n');
    admin.initializeApp({ credential: admin.credential.cert(obj) });
  }
}
function parseOrigins(csv){
  return String(csv || '').split(',').map(s=>s.trim()).filter(Boolean);
}
function pickOrigin(event){
  const allowed = parseOrigins(process.env.ALLOWED_ORIGINS) || [];
  const hdr = event.headers || {};
  const o = hdr.origin || hdr.Origin || (hdr.host ? `https://${hdr.host}` : '');
  const base = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  if (allowed.includes(o)) return o;
  return base || allowed[0] || '*';
}

exports.handler = async (event) => {
  initAdmin();
  const db = admin.firestore();

  const ORIGIN = pickOrigin(event);
  const cors = {
    'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  try {
    // Auth: either Admin secret or Firebase ID token
    const adminKey = process.env.ADMIN_PUSH_KEY || process.env.ADMIN_PUSH_SECRET;
    const s = event.headers['x-admin-secret'];
    if (!(adminKey && s && s === adminKey)) {
      const auth = event.headers.authorization || event.headers.Authorization || '';
      if (!auth.startsWith('Bearer ')) return { statusCode: 401, headers: cors, body: 'Unauthorized' };
      await admin.auth().verifyIdToken(auth.slice(7));
    }

    const body = JSON.parse(event.body || '{}');
    let { uid, title, body: msgBody, url = '/', tag = 'general_notice', data = {} } = body;
    if (!uid || !title) return { statusCode: 400, headers: cors, body: 'uid and title required' };

    const base = (process.env.APP_BASE_URL || 'https://bechobazaar.com').replace(/\/$/, '');
    if (!/^https?:\/\//.test(url)) url = `${base}${url.startsWith('/') ? '' : '/'}${url}`;

    // Collect endpoints (legacy + unified) → FCM tokens
    const tokens = new Set();
    const legacy = await db.collection('users').doc(uid).collection('fcmTokens').get();
    legacy.forEach(d => d.id && tokens.add(d.id));

    const pe = await db.collection('users').doc(uid).collection('pushEndpoints').get();
    pe.forEach(d => { const x=d.data()||{}; if ((x.type==='fcm_web'||x.type==='native') && x.token) tokens.add(x.token); });

    const tokenList = Array.from(tokens).filter(Boolean);
    let success = 0, failed = 0;

    if (tokenList.length){
      // ✅ DATA-ONLY FCM: NO 'notification' field → Chrome won't auto show
      const msg = {
        tokens: tokenList,
        data: {
          title: String(title),
          body:  String(msgBody || ''),
          url, tag: String(tag),
          ch: 'fcm',
          ...Object.fromEntries(Object.entries(data || {}).map(([k,v]) => [k, String(v)]))
        },
        webpush: { fcmOptions: { link: url }, headers: { Urgency:'high', TTL:'600' } },
        android: { priority: 'high' },
        apns: { headers: { 'apns-priority': '10' } }
      };
      const res = await admin.messaging().sendEachForMulticast(msg);
      success += res.successCount; failed += res.failureCount;

      // Clean invalid tokens from both stores
      for (let i=0;i<res.responses.length;i++){
        const r = res.responses[i];
        if (!r.success) {
          const code = r.error?.code || '';
          if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
            const bad = tokenList[i];
            try {
              await db.collection('users').doc(uid).collection('fcmTokens').doc(bad).delete().catch(()=>{});
              const qs = await db.collection('users').doc(uid).collection('pushEndpoints').where('token','==',bad).get();
              qs.forEach(d => d.ref.delete().catch(()=>{}));
            } catch {}
          }
        }
      }
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify({ sent: success, failed }) };
  } catch (e) {
    console.error('notify-user error', e);
    return { statusCode: 500, headers: cors, body: 'Internal Server Error' };
  }
};
