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

function cors(event){
  const o = event.headers.origin || event.headers.Origin || '*';
  return {
    'Access-Control-Allow-Origin': o || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
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
  const CORS = cors(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  try {
    const key = event.headers['x-admin-key'] || event.headers['X-Admin-Key'] || '';
    const envKey = process.env.ADMIN_PUSH_KEY || '';
    if (!envKey || !key || !timingSafeEqual(key, envKey)) {
      return { statusCode: 401, headers: CORS, body: 'Unauthorized' };
    }

    let args = {};
    try { args = JSON.parse(event.body || '{}'); } catch {}
    const limit = Math.max(1, Math.min(50, parseInt(args.limit || 20, 10)));
    const beforeMs = args.beforeMs ? parseInt(args.beforeMs, 10) : null;

    // Use createdAtMs (number) for reliable ordering without index hassle
    let q = db.collection('adminPushLogs').orderBy('createdAtMs', 'desc').limit(limit);
    if (beforeMs) q = db.collection('adminPushLogs').where('createdAtMs','<', beforeMs).orderBy('createdAtMs','desc').limit(limit);

    const snap = await q.get();
    const items = snap.docs.map(d => {
      const data = d.data() || {};
      return {
        id: d.id,
        title: data.title || '',
        message: data.message || '',
        link: data.link || '',
        image: data.image || null,
        audience: data.audience || 'all',
        uids: Array.isArray(data.uids) ? data.uids : [],
        sent: data.sent || 0,
        failed: data.failed || 0,
        tokens: data.tokens || 0,
        removedBadTokens: data.removedBadTokens || 0,
        detailsSample: Array.isArray(data.detailsSample) ? data.detailsSample : [],
        createdAtMs: data.createdAtMs || (data.createdAt && data.createdAt.toMillis ? data.createdAt.toMillis() : null)
      };
    });

    const nextBefore = items.length ? items[items.length - 1].createdAtMs : null;
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ items, nextBeforeMs: nextBefore }) };
  } catch (e) {
    console.error('list-admin-push-logs error', e);
    return { statusCode: 500, headers: CORS, body: 'Internal Server Error' };
  }
};
