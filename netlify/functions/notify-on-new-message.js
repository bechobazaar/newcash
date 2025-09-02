const admin = require('firebase-admin');

function readServiceAccount() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (b64) {
    const obj = JSON.parse(Buffer.from(b64.trim(), 'base64').toString('utf8'));
    if (obj.private_key) obj.private_key = obj.private_key.replace(/\\n/g, '\n');
    return obj;
  }
  const pk = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  if (pk && projectId && clientEmail) return { project_id: projectId, client_email: clientEmail, private_key: pk };
  throw new Error('Missing service account env');
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

function pickOrigin(event) {
  const h = event.headers || {};
  const origin = h.origin || h.Origin || (h.host ? `https://${h.host}` : '');
  return ALLOWED_ORIGINS.includes(origin)
    ? origin
    : (process.env.APP_BASE_URL || ALLOWED_ORIGINS[0] || '').replace(/\/$/, '');
}

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

    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    if (!authHeader.startsWith('Bearer ')) return { statusCode: 401, headers: cors, body: 'Missing auth token' };
    const idToken = authHeader.slice(7);
    const decoded = await admin.auth().verifyIdToken(idToken);

    let body; try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: cors, body: 'Invalid JSON body' }; }
    const { chatId, messageId } = body;
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

    const tokenDocs = [];
    for (const uid of recipients) {
      const qs = await db.collection('users').doc(uid).collection('fcmTokens').get();
      qs.forEach(d => tokenDocs.push({ token: d.id, ref: d.ref }));
    }
    if (!tokenDocs.length) return { statusCode: 200, headers: cors, body: JSON.stringify({ sent: 0, failed: 0 }) };

    const siteOrigin = (ORIGIN || process.env.APP_BASE_URL || 'https://bechobazaar.com').replace(/\/$/, '');
    const link = `${siteOrigin}/chat.html?chatId=${encodeURIComponent(chatId)}`;
    const notifBody = (m.text && m.text.trim()) || (m.imageUrl ? '📷 Photo' : 'New message');

    const base = {
      notification: { title: 'New message', body: notifBody },
      data: { chatId, senderId: String(m.senderId || ''), messageId },
      android: { priority: 'high' },
      webpush: {
        fcmOptions: { link },
        notification: { badge: '/icons/badge-72.png', icon: '/icons/icon-192.png' },
      },
    };

    let success = 0, fail = 0;
    for (let i = 0; i < tokenDocs.length; i += 500) {
      const slice = tokenDocs.slice(i, i + 500);
      const tokens = slice.map(t => t.token);
      const res = await admin.messaging().sendEachForMulticast({ tokens, ...base });
      success += res.successCount; fail += res.failureCount;
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

    return { statusCode: 200, headers: cors, body: JSON.stringify({ sent: success, failed: fail }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: cors, body: 'Internal Server Error' };
  }
};
