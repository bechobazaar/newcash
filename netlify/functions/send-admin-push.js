const crypto = require('crypto');
const admin = require('firebase-admin');

function cors(event){
  const origin = (event?.headers?.origin || event?.headers?.Origin || '*');
  return {
    'Access-Control-Allow-Origin': origin || '*',     // reflect origin
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
function tEqual(a,b){
  const A = Buffer.from(String(a||''), 'utf8');
  const B = Buffer.from(String(b||''), 'utf8');
  if (A.length !== B.length) return false;
  try { return crypto.timingSafeEqual(A, B); } catch { return false; }
}
function readServiceAccount() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_B64');
  const obj = JSON.parse(Buffer.from(b64.trim(), 'base64').toString('utf8'));
  if (obj.private_key) obj.private_key = obj.private_key.replace(/\\n/g, '\n');
  return obj;
}
if (!admin.apps.length) {
  const svc = readServiceAccount();
  admin.initializeApp({ credential: admin.credential.cert({
    projectId: svc.project_id || svc.projectId,
    clientEmail: svc.client_email || svc.clientEmail,
    privateKey: svc.private_key || svc.privateKey,
  })});
}
const db = admin.firestore();

exports.handler = async (event) => {
  const CORS = cors(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  try {
    // no-signin admin key
    const headerKey = event.headers['x-admin-key'] || event.headers['X-Admin-Key'] || '';
    const envKey = process.env.ADMIN_PUSH_KEY || '';
    if (!envKey || !headerKey || !tEqual(headerKey, envKey)) {
      return { statusCode: 401, headers: CORS, body: 'Unauthorized' };
    }

    let body = {};
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers: CORS, body: 'Invalid JSON body' }; }

    const title   = (body.title || '').toString().trim();
    const message = (body.message || '').toString();
    const image   = (body.image || body.imageUrl || '').toString().trim() || null;
    const link    = (body.link || 'https://bechobazzar.com/').toString().trim();
    const audience = (body.audience || 'all').toString();
    const uids = Array.isArray(body.uids) ? body.uids : [];
    if (!title) return { statusCode: 400, headers: CORS, body: 'title required' };

    // collect tokens
    let tokenRefs = [];
    async function addUserTokens(uid){
      const qs = await db.collection('users').doc(uid).collection('fcmTokens').get();
      qs.forEach(d => tokenRefs.push({ token: d.id, ref: d.ref }));
    }
    if (audience === 'uids' && uids.length) {
      for (const uid of uids) await addUserTokens(uid);
    } else {
      const cg = await db.collectionGroup('fcmTokens').get();
      tokenRefs = cg.docs.map(d => ({ token: d.id, ref: d.ref }));
    }

    const base = {
      notification: { title, body: message, ...(image ? { image } : {}) },
      data: { type: 'adminPush', link, ...(image ? { imageUrl: image } : {}) },
      android: { priority: 'high' },
      webpush: {
        fcmOptions: { link },
        headers: { Urgency: 'high' },
        notification: { title, body: message, icon: '/icons/icon-192.png', badge: '/icons/badge-72.png', ...(image ? { image } : {}) }
      }
    };

    let success = 0, failed = 0, removedBadTokens = 0;
    const detailsSample = [];
    for (let i = 0; i < tokenRefs.length; i += 500) {
      const slice = tokenRefs.slice(i, i + 500);
      const res = await admin.messaging().sendEachForMulticast({ tokens: slice.map(t=>t.token), ...base });
      success += res.successCount; failed += res.failureCount;
      res.responses.forEach((r, idx) => {
        if (detailsSample.length < 100) detailsSample.push({ ok: r.success, code: r.error?.code || null, token: slice[idx].token });
        if (!r.success) {
          const code = r.error?.code || '';
          if (code.includes('registration-token-not-registered') || code.includes('invalid-argument') || code.includes('messaging/registration-token-not-registered')) {
            removedBadTokens++;
            slice[idx].ref.delete().catch(()=>{});
          }
        }
      });
    }

    const nowMs = Date.now();
    const logRef = await db.collection('adminPushLogs').add({
      title, message, image: image || null, link, audience, uids: uids.slice(0,1000),
      sent: success, failed, tokens: tokenRefs.length, removedBadTokens,
      detailsSample, createdAt: admin.firestore.FieldValue.serverTimestamp(), createdAtMs: nowMs
    });

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ sent: success, failed, tokens: tokenRefs.length, logId: logRef.id }) };
  } catch (e) {
    console.error('send-admin-push error', e);
    return { statusCode: 500, headers: CORS, body: 'Internal Server Error' };
  }
};
