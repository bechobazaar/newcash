// netlify/functions/notify-on-new-message.js
// CORS allow-list
const ALLOWED_ORIGINS = new Set([
  'https://bechobazaar.com',
  'https://www.bechobazaar.com',
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
  };
}

// ---- Firebase Admin init (Netlify envs recommended) ----
const admin = require('firebase-admin');

if (!admin.apps.length) {
  // Prefer GOOGLE_APPLICATION_CREDENTIALS (JSON) in Netlify env, else use individual env vars
  try {
    // If you store the full service account JSON in env var FIREBASE_SERVICE_ACCOUNT
    const svcJson = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (svcJson) {
      admin.initializeApp({
        credential: admin.credential.cert(JSON.parse(svcJson)),
      });
    } else {
      // Or default creds (works if GOOGLE_APPLICATION_CREDENTIALS is set)
      admin.initializeApp();
    }
  } catch (e) {
    console.error('Admin init error', e);
    throw e;
  }
}

const db = admin.firestore();

exports.handler = async (event) => {
  const origin = event.headers?.origin || '';
  const headers = corsHeaders(origin);

  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: 'OK' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method Not Allowed' };
  }

  try {
    // ----- Auth: verify idToken from browser -----
    const authz = event.headers?.authorization || '';
    if (!/^Bearer\s.+/.test(authz)) {
      return { statusCode: 401, headers, body: 'Missing Authorization' };
    }
    const idToken = authz.replace(/^Bearer\s+/, '');
    let senderUid;
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      senderUid = decoded.uid;
    } catch (e) {
      return { statusCode: 401, headers, body: 'Invalid token' };
    }

    const { chatId, messageId, previewText } = JSON.parse(event.body || '{}');
    if (!chatId || !messageId) {
      return { statusCode: 400, headers, body: 'chatId & messageId required' };
    }

    // ----- Resolve recipient from chat -----
    const chatDoc = await db.collection('chats').doc(chatId).get();
    if (!chatDoc.exists) {
      return { statusCode: 404, headers, body: 'Chat not found' };
    }
    const users = Array.isArray(chatDoc.data().users) ? chatDoc.data().users : [];
    const recipientUid = users.find(u => u !== senderUid);
    if (!recipientUid) {
      return { statusCode: 400, headers, body: 'Recipient not found' };
    }

    // ----- Collect FCM tokens from users/{uid}/fcmTokens -----
    const tokensSnap = await db.collection('users').doc(recipientUid).collection('fcmTokens').get();
    const tokens = [];
    tokensSnap.forEach(d => {
      const tok = d.id || d.data()?.token;
      if (tok) tokens.push(tok);
    });
    if (!tokens.length) {
      // No tokens — nothing to send
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, sent: 0, reason: 'no-tokens' }) };
    }

    // ----- Compose data payload for your SW handler -----
    const openUrl = `https://bechobazaar.com/chat-list?open_conversation=${encodeURIComponent(chatId)}`;
    const title   = 'New message';
    const body    = (previewText && String(previewText).trim()) || 'New message received';

    // Use data payload (works with firebase-messaging-sw.js setBackgroundMessageHandler)
    const message = {
      tokens,
      data: {
        title,
        body,
        chatId,
        messageId,
        open_link_url: openUrl,
        // optional extras:
        click_action: openUrl,
      },
      // (optional) webpush headers if you like richer behavior
      webpush: {
        fcm_options: { link: openUrl },
        headers: {
          Urgency: 'high',
        },
      },
    };

    const resp = await admin.messaging().sendEachForMulticast(mess
