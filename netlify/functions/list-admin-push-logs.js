const crypto = require('crypto');
const admin = require('firebase-admin');

function cors(event){
  const origin = (event?.headers?.origin || event?.headers?.Origin || '*');
  return {
    'Access-Control-Allow-Origin': origin || '*',
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
    const key = event.headers['x-admin-key'] || event.headers['X-Admin-Key'] || '';
    const envKey = process.env.ADMIN_PUSH_KEY || '';
    if (!envKey || !tEqual(key, envKey)) return { statusCode: 401, headers: CORS, body: 'Unauthorized' };

    let args = {};
    try { args = JSON.parse(event.body || '{}'); } catch {}
    const limit = Math.max(1, Math.min(50, parseInt(args.limit || 20, 10)));
    const beforeMs = args.beforeMs ? parseInt(args.beforeMs, 10) : null;

    let q = db.collection('adminPushLogs').orderBy('createdAtMs','desc').limit(limit);
    if (beforeMs) q = db.collection('adminPushLogs').where('createdAtMs','<', beforeMs).orderBy('createdAtMs','desc').limit(limit);

    const snap = await q.get();
    const items = snap.docs.map(d => {
      const x = d.data() || {};
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
        createdAtMs: x.createdAtMs || (x.createdAt && x.createdAt.toMillis ? x.createdAt.toMillis() : null),
      };
    });
    const nextBeforeMs = items.length ? items[items.length-1].createdAtMs : null;

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ items, nextBeforeMs }) };
  } catch (e) {
    console.error('list-admin-push-logs error', e);
    return { statusCode: 500, headers: CORS, body: 'Internal Server Error' };
  }
};
