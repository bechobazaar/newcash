// netlify/functions/send-admin-push.js  (CommonJS)
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
  process.env.APP_BASE_URL
].filter(Boolean);

function pickOrigin(e){
  const h = e.headers || {};
  const o = h.origin || h.Origin || (h.host ? `https://${h.host}` : '');
  const best = (process.env.APP_BASE_URL || ALLOWED_ORIGINS[0] || '').replace(/\/$/, '');
  return ALLOWED_ORIGINS.includes(o) ? o : best;
}
const cors = (origin)=>({
  'Access-Control-Allow-Origin': origin || '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
});

exports.handler = async (event) => {
  const ORIGIN = pickOrigin(event);
  const CORS = cors(ORIGIN);

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  try {
    // 1) verify Firebase ID token
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    if (!authHeader.startsWith('Bearer ')) return { statusCode: 401, headers: CORS, body: 'Missing auth token' };
    const decoded = await admin.auth().verifyIdToken(authHeader.slice(7));

    // 2) allow only admins
    let isAdmin = false;
    const prof = await db.collection('users').doc(decoded.uid).get();
    if (prof.exists && (prof.get('isAdmin') === true || prof.get('role') === 'admin')) isAdmin = true;
    const email = (decoded.email || '').toLowerCase();
    if (email.endsWith('@bechobazaar.com')) isAdmin = true;
    if (!isAdmin) return { statusCode: 403, headers: CORS, body: 'Only admins can send push' };

    // 3) parse body
    let body; try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: CORS, body: 'Invalid JSON body' }; }
    const { title, message, imageUrl, link, uids } = body;
    if (!title) return { statusCode: 400, headers: CORS, body: 'title required' };

    const site = (process.env.APP_BASE_URL || 'https://bechobazaar.com').replace(/\/$/, '');
    const clickLink = (link && String(link)) || `${site}/`;

    // 4) collect tokens (targeted UIDs or broadcast all)
    let tokenRefs = [];
    if (Array.isArray(uids) && uids.length) {
      for (const uid of uids) {
        const qs = await db.collection('users').doc(uid).collection('fcmTokens').get();
        qs.forEach(d => tokenRefs.push({ token: d.id, ref: d.ref }));
      }
    } else {
      const cg = await db.collectionGroup('fcmTokens').get();
      tokenRefs = cg.docs.map(d => ({ token: d.id, ref: d.ref }));
    }
    if (!tokenRefs.length) return { statusCode: 200, headers: CORS, body: JSON.stringify({ sent:0, failed:0, tokens:0 }) };

    // 5) build message
    const base = {
      notification: {
        title: String(title),
        body : typeof message === 'string' ? message : '',
        ...(imageUrl ? { image: imageUrl } : {})
      },
      data: {
        type: 'adminPush',
        link: clickLink,
        ...(imageUrl ? { imageUrl } : {})
      },
      android: { priority: 'high' },
      webpush: {
        fcmOptions: { link: clickLink },
        headers: { Urgency: 'high' },
        notification: {
          title: String(title),
          body : typeof message === 'string' ? message : '',
          icon : '/icons/icon-192.png',
          badge: '/icons/badge-72.png',
          ...(imageUrl ? { image: imageUrl } : {})
        }
      }
    };

    // 6) send in batches
    let success = 0, failed = 0;
    for (let i = 0; i < tokenRefs.length; i += 500) {
      const slice = tokenRefs.slice(i, i + 500);
      const tokens = slice.map(t => t.token);
      const res = await admin.messaging().sendEachForMulticast({ tokens, ...base });
      success += res.successCount; failed += res.failureCount;

      // cleanup invalid tokens
      res.responses.forEach((r, idx) => {
        if (!r.success) {
          const code = r.error?.code || '';
          if (code.includes('registration-token-not-registered') ||
              code.includes('messaging/registration-token-not-registered') ||
              code.includes('invalid-argument')) {
            slice[idx].ref.delete().catch(() => {});
          }
        }
      });
    }

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ sent: success, failed, tokens: tokenRefs.length }) };
  } catch (err) {
    console.error('send-admin-push error', err);
    return { statusCode: 500, headers: CORS, body: 'Internal Server Error' };
  }
};
