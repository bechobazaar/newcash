// netlify/functions/notify-on-new-message.js

// ---------- CORS ----------
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
    'Access-Control-Max-Age': '86400',
  };
}

// ---------- Firebase Admin (Service Account in Base64 env) ----------
const admin = require('firebase-admin');

function getServiceAccountFromEnv() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 not set');
  const json = Buffer.from(b64, 'base64').toString('utf8');
  const svc  = JSON.parse(json);
  if (svc.private_key && svc.private_key.includes('\\n')) {
    svc.private_key = svc.private_key.replace(/\\n/g, '\n');
  }
  return svc;
}

if (!admin.apps.length) {
  const svc = getServiceAccountFromEnv();
  admin.initializeApp({
    credential: admin.credential.cert(svc),
    projectId: svc.project_id || 'olxhub-12479',
  });
  console.log('Admin project:', admin.app().options.projectId);
}

const db = admin.firestore();

// ---------- Handler ----------
exports.handler = async (event) => {
  const origin  = event.headers?.origin || '';
  const headers = corsHeaders(origin);

  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method Not Allowed' };
  }

  try {
    // 1) Verify idToken
    const authz = event.headers?.authorization || '';
    if (!/^Bearer\s.+/.test(authz)) {
      return { statusCode: 401, headers, body: 'Missing Authorization' };
    }
    const idToken = authz.replace(/^Bearer\s+/, '');

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      console.error('verifyIdToken error:', e?.errorInfo || e);
      return { statusCode: 401, headers, body: 'Invalid token' };
    }
    const senderUid = decoded.uid;

    // 2) Parse
    const { chatId, messageId, previewText } = JSON.parse(event.body || '{}');
    if (!chatId || !messageId) {
      return { statusCode: 400, headers, body: 'chatId & messageId required' };
    }

    // 3) Recipient resolve
    const chatDoc = await db.collection('chats').doc(chatId).get();
    if (!chatDoc.exists) return { statusCode: 404, headers, body: 'Chat not found' };
    const users = Array.isArray(chatDoc.data().users) ? chatDoc.data().users : [];
    const recipientUid = users.find(u => u !== senderUid);
    if (!recipientUid) return { statusCode: 400, headers, body: 'Recipient not found' };

    // 4) Tokens
    const snap = await db.collection('users').doc(recipientUid).collection('fcmTokens').get();
    const tokens = [];
    snap.forEach(d => {
      const tok = d.id || d.data()?.token;
      if (tok) tokens.push(tok);
    });
    if (!tokens.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok:true, sent:0, fail:0, reason:'no-tokens' }) };
    }

    // 5) Payload
    const openUrl = `https://bechobazaar.com/chat-list?open_conversation=${encodeURIComponent(chatId)}`;
    const multicast = {
      tokens,
      data: {
        title: 'New message',
        body: (previewText && String(previewText).trim()) || 'New message received',
        chatId,
        messageId,
        open_link_url: openUrl,
        click_action: openUrl,
      },
      webpush: {
        fcm_options: { link: openUrl },
        headers: { Urgency: 'high' },
      },
    };

    // 6) Send
    const resp = await admin.messaging().sendEachForMulticast(multicast);

    // 7) Errors (debug)
    const errors = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        errors.push({
          token: tokens[i],
          code:  r.error?.code || null,
          msg:   r.error?.message || null,
        });
      }
    });

    // 8) Cleanup invalid tokens
    const bad = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code || '';
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/third-party-auth-error' // Web Push auth mismatch → purge
        ) {
          bad.push(tokens[i]);
        }
      }
    });
    if (bad.length) {
      const batch = db.batch();
      bad.forEach((tk) =>
        batch.delete(db.collection('users').doc(recipientUid).collection('fcmTokens').doc(tk))
      );
      await batch.commit().catch(()=>{});
    }

    // 9) Optional: mark delivered
    try {
      await db.collection('chats').doc(chatId).collection('messages').doc(messageId)
        .set({ delivered: true }, { merge: true });
    } catch(_) {}

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok:true, sent: resp.successCount||0, fail: resp.failureCount||0, errors }),
    };
  } catch (e) {
    console.error('notify-on-new-message error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ ok:false, error: String(e?.message||e) }) };
  }
};
