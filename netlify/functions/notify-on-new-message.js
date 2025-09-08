// netlify/functions/notify-on-new-message.js
'use strict';

const admin = require('firebase-admin');

/* --------- Admin init --------- */
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
      projectId:   svc.project_id   || svc.projectId,
      clientEmail: svc.client_email || svc.clientEmail,
      privateKey:  svc.private_key  || svc.privateKey,
    }),
  });
}
const db = admin.firestore();

/* --------- CORS / origin --------- */
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
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'content-type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    /* ---- Auth: verify Firebase ID token ---- */
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Missing auth token' }) };
    }
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(authHeader.slice(7));
    } catch (e) {
      return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Invalid auth token' }) };
    }

    /* ---- Parse body ---- */
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

    const { chatId, messageId } = body || {};
    if (!chatId || !messageId) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'chatId and messageId required' }) };
    }

    /* ---- Read chat + message ---- */
    const chatRef = db.collection('chats').doc(chatId);
    const chatDoc = await chatRef.get();
    if (!chatDoc.exists) return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'Chat not found' }) };

    const users = Array.isArray(chatDoc.get('users')) ? chatDoc.get('users') : [];
    if (!users.includes(decoded.uid)) {
      return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'Not in chat' }) };
    }

    const msgSnap = await chatRef.collection('messages').doc(messageId).get();
    if (!msgSnap.exists) return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'Message not found' }) };
    const m = msgSnap.data() || {};

    const senderId = String(m.senderId || '');
    const recipients = users.filter(u => u !== senderId);
    if (!recipients.length) {
      return { statusCode: 200, headers: cors, body: JSON.stringify({ sent: 0, failed: 0, recipients: [], tokens: 0 }) };
    }

    /* ---- Collect tokens (parallel) ---- */
    let tokenDocs = [];
    const snaps = await Promise.all(
      recipients.map(uid => db.collection('users').doc(uid).collection('fcmTokens').get())
    );
    snaps.forEach(qs => qs.forEach(d => tokenDocs.push({ token: d.id, ref: d.ref })));

    // Dedupe by token string (avoid duplicate sends)
    if (tokenDocs.length) {
      const uniq = new Map();
      for (const t of tokenDocs) if (!uniq.has(t.token)) uniq.set(t.token, t);
      tokenDocs = Array.from(uniq.values());
    }

    if (!tokenDocs.length) {
      return { statusCode: 200, headers: cors, body: JSON.stringify({ sent: 0, failed: 0, recipients, tokens: 0 }) };
    }

    /* ---- Build payload (fixed title, no snippet) ---- */
    const siteOrigin = (ORIGIN || process.env.APP_BASE_URL || 'https://bechobazaar.com').replace(/\/$/, '');
    const link = `${siteOrigin}/chat-list.html`;
    const FIXED_TITLE = 'New message received';

    const base = {
      notification: { title: FIXED_TITLE, body: '' }, // no snippet
      data: { chatId, senderId, messageId, link },
      android: { priority: 'high' },
      webpush: {
        fcmOptions: { link },
        headers: { Urgency: 'high', TTL: '900' }, // 15min TTL
        notification: {
          title: FIXED_TITLE,
          body: '', // no snippet
          icon: '/icons/icon-192.png?v=6',
          badge: '/icons/badge-72.png?v=6'
        }
      }
    };

    /* ---- Send in chunks & cleanup invalid tokens ---- */
    let success = 0, failed = 0, removedBadTokens = 0;

    for (let i = 0; i < tokenDocs.length; i += 500) {
      const slice = tokenDocs.slice(i, i + 500);
      const tokens = slice.map(t => t.token);

      const res = await admin.messaging().sendEachForMulticast({ tokens, ...base });
      success += res.successCount;
      failed  += res.failureCount;

      const deletes = [];
      res.responses.forEach((r, idx) => {
        if (!r.success) {
          const code = r.error?.code || '';
          // delete only truly invalid/expired tokens
          if (code === 'messaging/registration-token-not-registered' ||
              code === 'messaging/invalid-registration-token') {
            removedBadTokens++;
            deletes.push(slice[idx].ref.delete());
          }
          // NOTE: do NOT delete on 'messaging/invalid-argument' (often payload/config issue)
        }
      });
      if (deletes.length) await Promise.allSettled(deletes);
    }

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({ sent: success, failed, recipients, tokens: tokenDocs.length, removedBadTokens })
    };

  } catch (err) {
    console.error('notify-on-new-message error', err);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Internal Server Error' }) };
  }
};
