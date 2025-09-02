// netlify/functions/notify-on-new-message.js
const admin = require('firebase-admin');

/** Read service account from env (B64 or triplet) */
function getServiceAccountFromEnv() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (b64) {
    try {
      const json = Buffer.from(b64.trim(), 'base64').toString('utf8');
      const obj = JSON.parse(json);
      if (obj.private_key) obj.private_key = obj.private_key.replace(/\\n/g, '\n'); // just in case
      return obj;
    } catch (e) {
      console.error('FIREBASE_SERVICE_ACCOUNT_B64 decode/parse failed', e);
      throw new Error('Invalid FIREBASE_SERVICE_ACCOUNT_B64');
    }
  }
  // Fallback to triplet envs
  const pk = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  if (projectId && clientEmail && pk) {
    return { project_id: projectId, client_email: clientEmail, private_key: pk };
  }
  throw new Error('Missing service account env');
}

if (!admin.apps.length) {
  const svc = getServiceAccountFromEnv();
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: svc.project_id || svc.projectId,
      clientEmail: svc.client_email || svc.clientEmail,
      privateKey: svc.private_key || svc.privateKey,
    }),
  });
}

const db = admin.firestore();

// CORS (safe defaults). Same-origin pe bhi OK; OPTIONS handled for preflight.
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const corsHeaders = {
  'Access-Control-Allow-Origin': CORS_ORIGIN,
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
    }

    // Verify Firebase ID token
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return { statusCode: 401, headers: corsHeaders, body: 'Missing auth token' };
    }
    const idToken = authHeader.slice(7);
    const decoded = await admin.auth().verifyIdToken(idToken);

    // Parse body
    let payload;
    try { payload = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers: corsHeaders, body: 'Invalid JSON body' }; }

    const { chatId, messageId } = payload;
    if (!chatId || !messageId) {
      return { statusCode: 400, headers: corsHeaders, body: 'chatId and messageId required' };
    }

    // Read chat & message
    const chatRef = db.collection('chats').doc(chatId);
    const chatDoc = await chatRef.get();
    if (!chatDoc.exists) return { statusCode: 404, headers: corsHeaders, body: 'Chat not found' };

    const users = chatDoc.get('users') || [];
    if (!users.includes(decoded.uid)) return { statusCode: 403, headers: corsHeaders, body: 'Not in chat' };

    const msgSnap = await chatRef.collection('messages').doc(messageId).get();
    if (!msgSnap.exists) return { statusCode: 404, headers: corsHeaders, body: 'Message not found' };
    const m = msgSnap.data() || {};

    // Recipients
    const recipients = users.filter(u => u !== m.senderId);
    if (!recipients.length) return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ sent: 0, failed: 0 }) };

    // Collect device tokens
    const tokenDocs = [];
    for (const uid of recipients) {
      const qs = await db.collection('users').doc(uid).collection('fcmTokens').get();
      qs.forEach((doc) => tokenDocs.push({ token: doc.id, ref: doc.ref })); // docId = token
    }
    if (!tokenDocs.length) return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ sent: 0, failed: 0 }) };

    const link = `${(process.env.APP_BASE_URL || 'https://example.com').replace(/\/$/, '')}/chat.html?chatId=${encodeURIComponent(chatId)}`;
    const body = (m.text && m.text.trim()) || (m.imageUrl ? '📷 Photo' : 'New message');

    const base = {
      notification: { title: 'New message', body },
      data: { chatId, senderId: String(m.senderId || ''), messageId },
      android: { priority: 'high' },
      webpush: {
        fcmOptions: { link },
        notification: { badge: '/icons/badge-72.png', icon: '/icons/icon-192.png' },
      },
    };

    // Chunk tokens (max 500 per multicast)
    const chunk = (arr, size) => arr.reduce((acc, _, i) => (i % size ? acc : [...acc, arr.slice(i, i + size)]), []);
    const batches = chunk(tokenDocs, 500);

    let successCount = 0;
    let failureCount = 0;
    const cleanup = [];

    for (const batch of batches) {
      const tokens = batch.map(t => t.token);
      // sendEachForMulticast gives per-token responses
      const res = await admin.messaging().sendEachForMulticast({ tokens, ...base });
      successCount += res.successCount;
      failureCount += res.failureCount;

      res.responses.forEach((r, i) => {
        if (!r.success) {
          const code = (r.error && r.error.code) || '';
          if (
            code.includes('registration-token-not-registered') ||
            code.includes('messaging/registration-token-not-registered') ||
            code.includes('invalid-argument')
          ) {
            cleanup.push(batch[i].ref.delete().catch(() => {}));
          }
        }
      });
    }
    if (cleanup.length) await Promise.all(cleanup);

    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ sent: successCount, failed: failureCount }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: corsHeaders, body: 'Internal Server Error' };
  }
};
