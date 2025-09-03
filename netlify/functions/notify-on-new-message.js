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
  process.env.APP_BASE_URL
].filter(Boolean);

const pickOrigin = (e) => {
  const h = e.headers || {};
  const o = h.origin || h.Origin || (h.host ? `https://${h.host}` : '');
  return ALLOWED_ORIGINS.includes(o)
    ? o
    : (process.env.APP_BASE_URL || ALLOWED_ORIGINS[0] || '').replace(/\/$/, '');
};

exports.handler = async (event) => {
  const ORIGIN = pickOrigin(event);
  const cors = {
    'Access-Control-Allow-Origin': ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  try {
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

    // Auth
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    if (!authHeader.startsWith('Bearer ')) return { statusCode: 401, headers: cors, body: 'Missing auth token' };
    const decoded = await admin.auth().verifyIdToken(authHeader.slice(7));

    // Body
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: cors, body: 'Invalid JSON body' }; }
    const { chatId, messageId } = body;
    if (!chatId || !messageId) return { statusCode: 400, headers: cors, body: 'chatId and messageId required' };

    // Read chat + message
    const chatRef = db.collection('chats').doc(chatId);
    const chatDoc = await chatRef.get();
    if (!chatDoc.exists) return { statusCode: 404, headers: cors, body: 'Chat not found' };
    const users = chatDoc.get('users') || [];
    if (!users.includes(decoded.uid)) return { statusCode: 403, headers: cors, body: 'Not in chat' };

    const msgSnap = await chatRef.collection('messages').doc(messageId).get();
    if (!msgSnap.exists) return { statusCode: 404, headers: cors, body: 'Message not found' };
    const m = msgSnap.data() || {};

    const recipients = users.filter(u => u !== m.senderId);

    // Collect tokens
    const tokenDocs = [];
    for (const uid of recipients) {
      const qs = await db.collection('users').doc(uid).collection('fcmTokens').get();
      qs.forEach(d => tokenDocs.push({ token: d.id, ref: d.ref }));
    }
    if (!tokenDocs.length) return { statusCode: 200, headers: cors, body: JSON.stringify({ sent: 0, failed: 0, recipients, tokens: 0 }) };

    const siteOrigin = (ORIGIN || process.env.APP_BASE_URL || 'https://bechobazaar.com').replace(/\/$/, '');
    const link = `${siteOrigin}/chat.html?chatId=${encodeURIComponent(chatId)}`;

    const FIXED_TITLE = 'New message received';

    const base = {
      // Android fallback + Safari/Mac
      notification: { title: FIXED_TITLE, body: '' },     // ✅ koi snippet nahi
      // Data for SW click handling
      data: { chatId, senderId: String(m.senderId || ''), messageId, link },
      android: { priority: 'high' },
      webpush: {
        fcmOptions: { link },
        notification: {
          title: FIXED_TITLE,
          body: '',                                       // ✅
          icon: '/icons/icon-192.png',
          badge: '/icons/badge-72.png'
        },
        headers: { Urgency: 'high' }
      }
    };

    // Send in batches
    let success = 0, failed = 0;
    for (let i = 0; i < tokenDocs.length; i += 500) {
      const slice = tokenDocs.slice(i, i + 500);
      const tokens = slice.map(t => t.token);
      const res = await admin.messaging().sendEachForMulticast({ tokens, ...base });
      success += res.successCount; failed += res.failureCount;
      // Clean invalid tokens
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

    return { statusCode: 200, headers: cors, body: JSON.stringify({ sent: success, failed, recipients, tokens: tokenDocs.length }) };
  } catch (err) {
    console.error('notify error', err);
    return { statusCode: 500, headers: cors, body: 'Internal Server Error' };
  }
};
