// netlify/functions/notify-on-new-message.js
const ALLOWED_ORIGINS = new Set([
  'https://bechobazaar.com',
  'https://www.bechobazaar.com',
  // dev:
  'http://localhost:3000',
  'http://localhost:5173',
]);

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://bechobazaar.com';
  return {
    'Access-Control-Allow-Origin': allow,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    // 'Access-Control-Allow-Credentials': 'true', // if you ever need it
  };
}

const admin = require('firebase-admin');
if (!admin.apps.length) {
  const svcJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (svcJson) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(svcJson)) });
  else admin.initializeApp();
}
const db = admin.firestore();

exports.handler = async (event) => {
  const origin  = event.headers?.origin || '';
  const headers = corsHeaders(origin);

  // --- CORS preflight must return CORS headers ---
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: 'OK' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method Not Allowed' };
  }

  try {
    // Auth
    const authz = event.headers?.authorization || '';
    if (!/^Bearer\s.+/.test(authz)) {
      return { statusCode: 401, headers, body: 'Missing Authorization' };
    }
    const idToken = authz.replace(/^Bearer\s+/, '');
    const decoded = await admin.auth().verifyIdToken(idToken).catch(() => null);
    if (!decoded) {
      return { statusCode: 401, headers, body: 'Invalid token' };
    }

    const { chatId, messageId, previewText } = JSON.parse(event.body || '{}');
    if (!chatId || !messageId) {
      return { statusCode: 400, headers, body: 'chatId & messageId required' };
    }

    // Resolve recipient
    const chatDoc = await db.collection('chats').doc(chatId).get();
    if (!chatDoc.exists) return { statusCode: 404, headers, body: 'Chat not found' };
    const users = Array.isArray(chatDoc.data().users) ? chatDoc.data().users : [];
    const recipientUid = users.find(u => u !== decoded.uid);
    if (!recipientUid) return { statusCode: 400, headers, body: 'Recipient not found' };

    // Collect tokens
    const snap = await db.collection('users').doc(recipientUid).collection('fcmTokens').get();
    const tokens = [];
    snap.forEach(d => { const t = d.id || d.data()?.token; if (t) tokens.push(t); });
    if (!tokens.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, sent: 0, reason: 'no-tokens' }) };
    }

    // FCM payload (data-only; your SW reads data.title/body/open_link_url)
    const openUrl = `https://bechobazaar.com/chat-list?open_conversation=${encodeURIComponent(chatId)}`;
    const message = {
      tokens,
      data: {
        title: 'New message',
        body: (previewText && String(previewText).trim()) || 'New message received',
        chatId, messageId, open_link_url: openUrl, click_action: openUrl,
      },
      webpush: { fcm_options: { link: openUrl }, headers: { Urgency: 'high' } },
    };

    const resp = await admin.messaging().sendEachForMulticast(message);

    // Cleanup invalid tokens
    const bad = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code || '';
        if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
          bad.push(tokens[i]);
        }
      }
    });
    if (bad.length) {
      const batch = db.batch();
      bad.forEach(tk => batch.delete(db.collection('users').doc(recipientUid).collection('fcmTokens').doc(tk)));
      await batch.commit().catch(()=>{});
    }

    // Optional quick delivered mark
    try {
      await db.collection('chats').doc(chatId).collection('messages').doc(messageId)
        .set({ delivered: true }, { merge: true });
    } catch (_) {}

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, sent: resp.successCount || 0, fail: resp.failureCount || 0 }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: String(e?.message || e) }) };
  }
};
