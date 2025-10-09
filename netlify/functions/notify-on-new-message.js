// netlify/functions/notify-on-new-message.js

// --- allow your web origins here ---
const ALLOWED_ORIGINS = new Set([
  'https://bechobazaar.com',
  'https://www.bechobazaar.com',
  // local dev origins (optional):
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

exports.handler = async (event, context) => {
  const origin = event.headers?.origin || '';
  const headers = corsHeaders(origin);

  // --- CORS preflight ---
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: 'OK' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method Not Allowed' };
  }

  try {
    // ---- Auth (idToken from browser) ----
    const authz = event.headers?.authorization || '';
    if (!/^Bearer\s.+/.test(authz)) {
      return { statusCode: 401, headers, body: 'Missing Authorization' };
    }
    const idToken = authz.replace(/^Bearer\s+/, '');

    // TODO: Verify with Firebase Admin
    // const admin = require('firebase-admin');
    // if (!admin.apps.length) admin.initializeApp();
    // const decoded = await admin.auth().verifyIdToken(idToken);

    const body = JSON.parse(event.body || '{}');
    const { chatId, messageId } = body;
    if (!chatId || !messageId) {
      return { statusCode: 400, headers, body: 'chatId & messageId required' };
    }

    // TODO: Lookup recipient UID(s) by chatId
    // const chatDoc = await admin.firestore().doc(`chats/${chatId}`).get();
    // const users = chatDoc.data().users || [];
    // const recipient = users.find(u => u !== decoded.uid);

    // TODO: Read users/{recipient}/fcmTokens/*
    // const tokensSnap = await admin.firestore()
    //   .collection('users').doc(recipient).collection('fcmTokens').get();
    // const tokens = tokensSnap.docs.map(d => d.id || d.data().token).filter(Boolean);

    // TODO: Send FCM
    // if (tokens.length) {
    //   await admin.messaging().sendMulticast({
    //     tokens,
    //     notification: { title: 'New message', body: 'You have a new message' },
    //     data: { chatId, messageId, open_link_url: `https://bechobazaar.com/chat-list?open_conversation=${chatId}` },
    //   });
    // }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: String(e?.message || e) }),
    };
  }
};
