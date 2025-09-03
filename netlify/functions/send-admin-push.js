const crypto = require('crypto');
const admin = require('firebase-admin');

/* ---------- CORS (always set) ---------- */
function cors(event) {
  const origin = (event?.headers?.origin || event?.headers?.Origin || '*');
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
function tEqual(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (A.length !== B.length) return false;
  try { return crypto.timingSafeEqual(A, B); } catch { return false; }
}

/* ---------- Firebase Admin init ---------- */
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

/* ---------- Config ---------- */
const SITE_ORIGIN = (process.env.SITE_ORIGIN || 'https://bechobazaar.com').replace(/\/+$/, '');
const ANDROID_PKG = process.env.ANDROID_PKG || ''; // e.g. com.bechobazaar.app

function normalizeLink(input) {
  try { return new URL(input, SITE_ORIGIN + '/').toString(); }
  catch { return SITE_ORIGIN + '/'; }
}
function buildAndroidIntentUrl(absLink) {
  if (!ANDROID_PKG) return '';
  try {
    const u = new URL(absLink);
    const scheme = (u.protocol.replace(':', '') || 'https');
    const pathAndQuery = `${u.pathname}${u.search}`;
    return `intent://${u.host}${pathAndQuery}#Intent;scheme=${scheme};package=${ANDROID_PKG};S.browser_fallback_url=${encodeURIComponent(absLink)};end`;
  } catch {
    return '';
  }
}

/* ---------- Handler ---------- */
exports.handler = async (event) => {
  const CORS = cors(event);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  try {
    /* Auth (no-signin) */
    const headerKey = event.headers['x-admin-key'] || event.headers['X-Admin-Key'] || '';
    const envKey = process.env.ADMIN_PUSH_KEY || '';
    if (!envKey || !headerKey || !tEqual(headerKey, envKey)) {
      return { statusCode: 401, headers: CORS, body: 'Unauthorized' };
    }

    /* Parse body */
    let body = {};
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers: CORS, body: 'Invalid JSON body' }; }

    const title    = (body.title || '').toString().trim();
    const message  = (body.message || '').toString();
    const image    = (body.image || body.imageUrl || '').toString().trim() || null;
    const audience = (body.audience || 'all').toString();
    const uids     = Array.isArray(body.uids) ? body.uids : [];
    if (!title) return { statusCode: 400, headers: CORS, body: 'title required' };

    /* Link: fix bechobazaar.com (no typos), allow relative */
    const linkIn  = (body.link || SITE_ORIGIN + '/').toString().trim();
    const linkAbs = normalizeLink(linkIn);
    const intentUrl = buildAndroidIntentUrl(linkAbs); // Android app if installed; otherwise browser fallback

    /* Collect tokens (de-duplicate) */
    const tokenMap = new Map(); // token -> { ref }
    async function addUserTokens(uid) {
      const qs = await db.collection('users').doc(uid).collection('fcmTokens').get();
      qs.forEach(d => {
        const t = d.id;
        if (t && !tokenMap.has(t)) tokenMap.set(t, { ref: d.ref });
      });
    }

    if (audience === 'uids' && uids.length) {
      for (const uid of uids) await addUserTokens(uid);
    } else {
      const cg = await db.collectionGroup('fcmTokens').get();
      cg.docs.forEach(d => {
        const t = d.id;
        if (t && !tokenMap.has(t)) tokenMap.set(t, { ref: d.ref });
      });
    }

    const tokenRefs = Array.from(tokenMap.entries()).map(([token, v]) => ({ token, ref: v.ref }));
    const totalTokens = tokenRefs.length;

    /* Build payload */
    const base = {
      notification: { title, body: message, ...(image ? { image } : {}) },
      data: { type: 'adminPush', link: linkAbs, intentUrl, ...(image ? { imageUrl: image } : {}) },
      android: { priority: 'high' },
      webpush: {
        fcmOptions: { link: linkAbs },
        headers: { Urgency: 'high' },
        notification: {
          title, body: message,
          icon: '/icons/icon-192.png?v=6',
          badge: '/icons/badge-72.png?v=6',
          ...(image ? { image } : {})
        }
      }
    };

    /* Send in chunks */
    let success = 0, failed = 0, removedBadTokens = 0;
    const detailsSample = []; // keep small
    for (let i = 0; i < tokenRefs.length; i += 500) {
      const slice = tokenRefs.slice(i, i + 500);
      const res = await admin.messaging().sendEachForMulticast({
        tokens: slice.map(t => t.token),
        ...base
      });
      success += res.successCount; failed += res.failureCount;

      res.responses.forEach((r, idx) => {
        if (detailsSample.length < 100) {
          detailsSample.push({
            ok: r.success,
            code: r.error?.code || null,
            token: slice[idx].token
          });
        }
        if (!r.success) {
          const code = r.error?.code || '';
          if (
            code.includes('registration-token-not-registered') ||
            code.includes('messaging/registration-token-not-registered') ||
            code.includes('invalid-argument')
          ) {
            removedBadTokens++;
            slice[idx].ref.delete().catch(() => {});
          }
        }
      });
    }

    /* Log */
    const nowMs = Date.now();
    const logRef = await db.collection('adminPushLogs').add({
      title, message, image: image || null,
      link: linkAbs, intentUrl,
      audience, uids: uids.slice(0, 1000),
      sent: success, failed, tokens: totalTokens, removedBadTokens,
      detailsSample,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAtMs: nowMs
    });

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ sent: success, failed, tokens: totalTokens, logId: logRef.id })
    };
  } catch (e) {
    console.error('send-admin-push error', e);
    return { statusCode: 500, headers: CORS, body: 'Internal Server Error' };
  }
};
