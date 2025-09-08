'use strict';

const crypto = require('crypto');
const admin  = require('firebase-admin');

/* ---------- CORS / utils ---------- */
function cors(event){
  const origin = (event?.headers?.origin || event?.headers?.Origin || '*');
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'content-type': 'application/json'
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

/* ---------- Admin init ---------- */
if (!admin.apps.length) {
  const svc = readServiceAccount();
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   svc.project_id   || svc.projectId,
      clientEmail: svc.client_email || svc.clientEmail,
      privateKey:  svc.private_key  || svc.privateKey,
    })
  });
}
const db = admin.firestore();

/* ---------- Handler ---------- */
exports.handler = async (event) => {
  const CORS = cors(event);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    /* --- auth with timing-safe key compare --- */
    const headerKey = event.headers['x-admin-key'] || event.headers['X-Admin-Key'] || '';
    const envKey    = process.env.ADMIN_PUSH_KEY || '';
    if (!envKey || !tEqual(headerKey, envKey)) {
      return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    /* --- parse body --- */
    let args = {};
    try { args = JSON.parse(event.body || '{}'); } catch {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    // pagination + optional filters
    const limit     = Math.max(1, Math.min(100, parseInt(args.limit || 20, 10)));
    const beforeMs  = args.beforeMs ? parseInt(args.beforeMs, 10) : null; // legacy offset
    const cursorMs  = args.cursorMs ? parseInt(args.cursorMs, 10) : null; // recommended
    const audience  = (args.audience || '').trim(); // e.g. 'all' or 'uids'; optional filter

    let q = db.collection('adminPushLogs');

    if (audience) q = q.where('audience', '==', audience);

    // Prefer cursor (startAfter) for stable pagination; fallback to where < beforeMs
    q = q.orderBy('createdAtMs', 'desc');

    if (cursorMs) {
      q = q.startAfter(cursorMs);
    } else if (beforeMs) {
      q = q.where('createdAtMs', '<', beforeMs);
    }

    q = q.limit(limit);

    const snap = await q.get();

    const items = snap.docs.map(d => {
      const x = d.data() || {};
      const createdAtMs = x.createdAtMs || (x.createdAt?.toMillis ? x.createdAt.toMillis() : null);
      return {
        id: d.id,
        title: x.title || '',
        message: x.message || '',
        link: x.link || '',
        image: x.image || null,
        audience: x.audience || 'all',
        uids: Array.isArray(x.uids) ? x.uids : [],
        sent: x.sent || 0,
        failed: x.failed || 0,
        tokens: x.tokens || 0,
        removedBadTokens: x.removedBadTokens || 0,
        detailsSample: Array.isArray(x.detailsSample) ? x.detailsSample : [],
        createdAtMs
      };
    });

    // next cursor (use last item's createdAtMs)
    const nextCursorMs = items.length ? items[items.length - 1].createdAtMs : null;

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ items, nextCursorMs }) };

  } catch (e) {
    console.error('list-admin-push-logs error', e);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Internal Server Error' }) };
  }
};
