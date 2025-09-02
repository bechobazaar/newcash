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

// CORS: allow your real frontend origin(s)
const ALLOWED_ORIGINS = [
  process.env.APP_BASE_URL,                  // e.g., https://bechobazaar.com
  'https://bechobazaar.com'              // add if you serve on www also
].filter(Boolean);

function pickOrigin(event) {
  const h = event.headers || {};
  const origin = h.origin || h.Origin || '';
  return ALLOWED_ORIGINS.includes(origin) ? origin : (ALLOWED_ORIGINS[0] || '*');
}
function chunk(a,n){const o=[];for(let i=0;i<a.length;i+=n)o.push(a.slice(i,i+n));return o;}

exports.handler = async (event) => {
  const ORIGIN = pickOrigin(event);
  const cors = {
    'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    if (!authHeader.startsWith('Bearer ')) return { statusCode: 401, headers: cors, body: 'Missing auth token' };
    const idToken = authHeader.slice(7);
    const decoded = await admin.auth().verifyIdToken(idToken);

    let body; try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers: cors, body: 'Invalid JSON body' }; }

    const { chatId, messageId } = body || {};
    if (!chatId || !messageId) return { statusCode: 400, headers: cors, body: 'chatId and messageId required' };

    const chatRef = db.collection('chats').doc(chatId);
    const chatDoc = await chatRef.get();
    if (!chatDoc.exists) return { statusCode: 404, headers: cors, body: 'Chat not found' };

    const users = chatDoc.get('users') || [];
    if (!users.includes(decoded.uid)) return { statusCode: 403, headers: cors, body: 'Not in chat' };

    const msgSnap = await chatRef.collection('messages').doc(messageId).get();
    if (!msgSnap.exists) return { statusCode: 404, headers: cors, body: 'Message not found' };
    const m = msgSnap.data() || {};

    const recipients = users.filter(u => u !== m.senderId);
    if (!recipients.length) return { statusCode: 200, headers: cors, body: JSON.stringify({ sent: 0, failed: 0 }) };

    const tokenHolders = [];
    for (const uid of recipients) {
      const qs = await db.collection('users').doc(uid).collection('fcmTokens').get();
      qs.forEach(d => {
        const data = d.data() || {};
        const token = data.token || d.id; // support legacy
        if (token) tokenHolders.push({ token, ref: d.ref });
      });
    }
    if (!tokenHolders.length) return { statusCode: 200, headers: cors, body: JSON.stringify({ sent: 0, failed: 0 }) };

    const siteOrigin = (process.env.APP_BASE_URL || 'https://bechobazaar.com').replace(/\/$/,'');
    const link = `${siteOrigin}/chat.html?chatId=${encodeURIComponent(chatId)}`;
    const bodyText = (m.text && m.text.trim()) || (m.imageUrl ? '📷 Photo' : 'New message');

    const base = {
      notification: { title: 'New message', body: bodyText },
      data: { chatId, senderId: String(m.senderId || ''), messageId },
      android: { priority: 'high' },
      webpush: { fcmOptions: { link }, notification: { badge: '/icons/badge-72.png', icon: '/icons/icon-192.png' } },
    };

    let success=0, failed=0;
    for (const slice of chunk(tokenHolders, 500)) {
      const res = await admin.messaging().sendEachForMulticast({ tokens: slice.map(t=>t.token), ...base });
      success += res.successCount; failed += res.failureCount;
      res.responses.forEach((r,i)=>{
        if (!r.success) {
          const code = r.error?.code || '';
          if (code.includes('registration-token-not-registered') ||
              code.includes('messaging/registration-token-not-registered') ||
              code.includes('invalid-argument') ||
              code.includes('mismatch-sender-id')) {
            slice[i].ref.delete().catch(()=>{});
          }
        }
      });
    }
    return { statusCode: 200, headers: cors, body: JSON.stringify({ sent: success, failed }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: cors, body: 'Internal Server Error' };
  }
};
