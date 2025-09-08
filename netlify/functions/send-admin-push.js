'use strict';

const crypto = require('crypto');
const admin  = require('firebase-admin');

/* ---------- Utils ---------- */
function cors(event){
  const origin = (event?.headers?.origin || event?.headers?.Origin || '*');
  return {
    'Access-Control-Allow-Origin': origin || '*',     // reflect origin
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'content-type': 'application/json',
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

/* ---------- Firebase Admin init ---------- */
if (!admin.apps.length) {
  const svc = readServiceAccount();
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   svc.project_id   || svc.projectId,
      clientEmail: svc.client_email || svc.clientEmail,
      privateKey:  svc.private_key  || svc.privateKey,
    }),
  });
}
const db = admin.firestore();

/* ---------- Handler ---------- */
exports.handler = async (event) => {
  const CORS = cors(event);

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    /* ---- Auth: HMAC-like admin key (timing safe) ---- */
    const headerKey = event.headers['x-admin-key'] || event.headers['X-Admin-Key'] || '';
    const envKey    = process.env.ADMIN_PUSH_KEY || '';
    if (!envKey || !headerKey || !tEqual(headerKey, envKey)) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    /* ---- Parse body ---- */
    let body = {};
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

    const title    = (body.title || '').toString().trim();
    const message  = (body.message || '').toString();
    const image    = (body.image || body.imageUrl || '').toString().trim() || null;
    const link     = (body.link || 'https://bechobazzar.com/').toString().trim();
    const audience = (body.audience || 'all').toString();
    const uids     = Array.isArray(body.uids) ? body.uids : [];
    if (!title) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'title required' }) };
    }

    /* ---- Collect tokens ---- */
    let tokenRefs = [];
    async function addUserTokens(uid){
      const qs = await db.collection('users').doc(uid).collection('fcmTokens').get();
      qs.forEach(d => tokenRefs.push({ token: d.id, ref: d.ref, data: d.data() }));
    }

    if (audience === 'uids' && uids.length) {
      for (const uid of uids) await addUserTokens(uid);
    } else {
      const cg = await db.collectionGroup('fcmTokens').get();
      tokenRefs = cg.docs.map(d => ({ token: d.id, ref: d.ref, data: d.data() }));
    }

    // ✅ Dedupe by token string (avoid double sends)
    if (tokenRefs.length) {
      const uniq = new Map();
      for (const tr of tokenRefs) if (!uniq.has(tr.token)) uniq.set(tr.token, tr);
      tokenRefs = Array.from(uniq.values());
    }

    // (Optional) recent filter: set FCM_RECENT_DAYS env (e.g., 90) to skip very old/stale tokens
    const RECENT_DAYS = parseInt(process.env.FCM_RECENT_DAYS || '0', 10);
    if (RECENT_DAYS > 0) {
      const cutoff = Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000;
      tokenRefs = tokenRefs.filter(t => {
        const ls = t.data?.lastSeenAt?.toMillis?.() || t.data?.createdAt?.toMillis?.();
        return !ls || ls >= cutoff; // if timestamp missing, keep it
      });
    }

    if (!tokenRefs.length) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ sent: 0, failed: 0, tokens: 0 }) };
    }

    /* ---- Payload ---- */
    const base = {
      notification: { title, body: message, ...(image ? { image } : {}) },
      data: { type: 'adminPush', link, ...(image ? { imageUrl: image } : {}) },
      android: { priority: 'high' },
      webpush: {
        fcmOptions: { link },
        headers: { Urgency: 'high', TTL: '1800' }, // 30 min TTL
        notification: {
          title,
          body: message,
          icon: '/icons/icon-192.png',
          badge: '/icons/badge-72.png',
          ...(image ? { image } : {})
        }
      }
    };

    /* ---- Send in chunks & cleanup bad tokens ---- */
    let success = 0, failed = 0, removedBadTokens = 0;
    const detailsSample = [];

    for (let i = 0; i < tokenRefs.length; i += 500) {
      const slice = tokenRefs.slice(i, i + 500);
      const tokens = slice.map(t => t.token);

      const res = await admin.messaging().sendEachForMulticast({ tokens, ...base });
      success += res.successCount;
      failed  += res.failureCount;

      const deletes = [];
      res.responses.forEach((r, idx) => {
        const tok = tokens[idx];

        if (detailsSample.length < 100) {
          detailsSample.push({ ok: r.success, code: r.error?.code || null, token: tok });
        }

        if (!r.success) {
          const code = r.error?.code || '';
          // ✅ only delete truly invalid/expired tokens
          if (code === 'messaging/registration-token-not-registered' ||
              code === 'messaging/invalid-registration-token') {
            removedBadTokens++;
            deletes.push(slice[idx].ref.delete());
          }
          // Note: 'messaging/invalid-argument' often means payload/config issue — don't delete on this.
        }
      });

      if (deletes.length) await Promise.allSettled(deletes);
    }

    /* ---- Log ---- */
    const nowMs = Date.now();
    const logRef = await db.collection('adminPushLogs').add({
      title, message, image: image || null, link, audience, uids: uids.slice(0,1000),
      sent: success, failed, tokens: tokenRefs.length, removedBadTokens,
      detailsSample,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAtMs: nowMs
    });

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ sent: success, failed, tokens: tokenRefs.length, removedBadTokens, logId: logRef.id })
    };

  } catch (e) {
    console.error('send-admin-push error', e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Internal Server Error' }) };
  }
};
