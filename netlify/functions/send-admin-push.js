// netlify/functions/send-admin-push.js
const crypto = require('crypto');
const admin = require('firebase-admin');

function readServiceAccount() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_B64');
  const obj = JSON.parse(Buffer.from(b64.trim(), 'base64').toString('utf8'));
  if (obj.private_key) obj.private_key = obj.private_key.replace(/\\n/g, '\n');
  return obj;
}

if (!admin.apps.length) {
  const svc = readServiceAccount();
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: svc.project_id || svc.projectId,
      clientEmail: svc.client_email || svc.clientEmail,
      privateKey: svc.private_key || svc.privateKey,
    }),
  });
}

const db = admin.firestore();

const ALLOWED_ORIGINS = [
  'https://bechobazaar.com',
  'https://www.bechobazaar.com',
  'https://bechobazaar.netlify.app',
  'https://bechobazzar.com',
  'https://www.bechobazzar.com',
  'http://localhost:3000',
  process.env.APP_BASE_URL
].filter(Boolean);

function buildCORS(event){
  const hdr = event.headers || {};
  const rawOrigin = hdr.origin || hdr.Origin || '';
  const isNull = !rawOrigin || rawOrigin === 'null';
  const allowOrigin = ALLOWED_ORIGINS.includes(rawOrigin) ? rawOrigin : (isNull ? '*' : '*');
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function timingSafeEqual(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (A.length !== B.length) return false;
  try { return crypto.timingSafeEqual(A, B); } catch { return false; }
}

exports.handler = async (event) => {
  const CORS = buildCORS(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  try {
    // Auth via X-Admin-Key
    const headerKey = event.headers['x-admin-key'] || event.headers['X-Admin-Key'];
    const envKey = process.env.ADMIN_PUSH_KEY || '';
    if (!envKey || !headerKey || !timingSafeEqual(headerKey, envKey)) {
      return { statusCode: 401, headers: CORS, body: 'Unauthorized' };
    }

    // Body
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers: CORS, body: 'Invalid JSON body' }; }

    const title   = (body.title || '').toString().trim();
    const message = (body.message || '').toString();
    const image   = (body.image || body.imageUrl || '').toString().trim() || null;
    const link    = (body.link || 'https://bechobazzar.com/').toString().trim();
    const audience = (body.audience || 'all').toString();
    const uids = Array.isArray(body.uids) ? body.uids : [];
    if (!title) return { statusCode: 400, headers: CORS, body: 'title required' };

    // Collect tokens
    let tokenRefs = [];
    async function addUserTokens(uid) {
      const qs = await db.collection('users').doc(uid).collection('fcmTokens').get();
      qs.forEach(d => tokenRefs.push({ token: d.id, ref: d.ref }));
    }
    if (audience === 'uids' && uids.length) {
      for (const uid of uids) await addUserTokens(uid);
    } else {
      const cg = await db.collectionGroup('fcmTokens').get();
      tokenRefs = cg.docs.map(d => ({ token: d.id, ref: d.ref }));
    }
    const totalTokens = tokenRefs.length;
    if (!totalTokens) {
      // Still log the attempt
      const logRef = await db.collection('adminPushLogs').add({
        title, message, image: image || null, link, audience,
        uids: uids.slice(0,1000), // cap
        sent: 0, failed: 0, tokens: 0, removedBadTokens: 0,
        detailsSample: [],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ sent:0, failed:0, tokens:0, logId: logRef.id }) };
    }

    // Build FCM payload
    const base = {
      notification: { title, body: message, ...(image ? { image } : {}) },
      data: { type: 'adminPush', link, ...(image ? { imageUrl: image } : {}) },
      android: { priority: 'high' },
      webpush: {
        fcmOptions: { link },
        headers: { Urgency: 'high' },
        notification: {
          title, body: message,
          icon: '/icons/icon-192.png',
          badge: '/icons/badge-72.png',
          ...(image ? { image } : {})
        }
      }
    };

    // Send & gather details (sample)
    let success = 0, failed = 0, removedBadTokens = 0;
    const detailsSample = []; // keep first 100
    for (let i = 0; i < tokenRefs.length; i += 500) {
      const slice = tokenRefs.slice(i, i + 500);
      const tokens = slice.map(t => t.token);
      const res = await admin.messaging().sendEachForMulticast({ tokens, ...base });
      success += res.successCount; failed += res.failureCount;

      res.responses.forEach((r, idx) => {
        const det = {
          ok: r.success,
          code: r.error?.code || null,
          msg: r.error?.message || null,
          token: slice[idx].token
        };
        if (detailsSample.length < 100) detailsSample.push(det);

        if (!r.success) {
          const code = r.error?.code || '';
          if (code.includes('registration-token-not-registered') ||
              code.includes('messaging/registration-token-not-registered') ||
              code.includes('invalid-argument')) {
            removedBadTokens++;
            slice[idx].ref.delete().catch(() => {});
          }
        }
      });
    }

    // Write log
    const logDoc = {
      title, message, image: image || null, link, audience,
      uids: uids.slice(0,1000),
      sent: success,
      failed: failed,
      tokens: totalTokens,
      removedBadTokens,
      detailsSample,  // up to 100 items with ok/code/msg/token
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const logRef = await db.collection('adminPushLogs').add(logDoc);

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ sent: success, failed, tokens: totalTokens, logId: logRef.id }) };
  } catch (err) {
    console.error('send-admin-push error', err);
    return { statusCode: 500, headers: CORS, body: 'Internal Server Error' };
  }
};
