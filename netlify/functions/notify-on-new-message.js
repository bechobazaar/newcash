// netlify/functions/notify-on-new-message.js
const admin = require('firebase-admin');
const fetch = require('node-fetch');

if (!admin.apps.length) {
  admin.initializeApp({});
}
const db = admin.firestore();

// Optional: Appilix push config
const APPILIX_PUSH_URL = process.env.APPILIX_PUSH_URL || '';
const APPILIX_KEY      = process.env.APPILIX_KEY || '';

// ---- CORS ----
const ALLOW_ORIGIN = 'https://bechobazaar.com'; // exact origin yahin rakho
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

// ---- helpers (same as before) ----
async function getRecipients(chatId, excludeUid) {
  const c = await db.collection('chats').doc(chatId).get();
  if (!c.exists) return [];
  const members = Array.isArray(c.data().members) ? c.data().members : [];
  return members.filter(uid => uid && uid !== excludeUid);
}
async function getMessage(chatId, messageId) {
  const ref = db.collection('chats').doc(chatId).collection('messages').doc(messageId);
  const snap = await ref.get();
  return snap.exists ? ({ id: snap.id, ...snap.data() }) : null;
}
async function getUserTokens(uid) {
  const tokens = [];
  const endpoints = [];
  const tokSnap = await db.collection('users').doc(uid).collection('fcmTokens').get();
  tokSnap.forEach(d => tokens.push(d.id));
  const endSnap = await db.collection('users').doc(uid).collection('pushEndpoints').get();
  endSnap.forEach(d => endpoints.push({ id: d.id, ...d.data() }));
  return { tokens, endpoints };
}
async function sendFCM(tokens, payload) {
  if (!tokens.length) return { ok: true, count: 0 };
  const res = await admin.messaging().sendToDevice(tokens, payload, { priority: 'high' });
  return { ok: true, res };
}
async function sendAppilix(endpoints, title, body, url) {
  if (!APPILIX_PUSH_URL || !APPILIX_KEY) return { ok: true };
  const nativeTargets = endpoints.filter(e => (e.type || '').startsWith('appilix'));
  if (!nativeTargets.length) return { ok: true };
  try{
    const payload = { title, body, url, endpoints: nativeTargets.map(n => n.token || n.id) };
    const r = await fetch(APPILIX_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': APPILIX_KEY },
      body: JSON.stringify(payload)
    });
    return { ok: r.ok, status: r.status };
  }catch(e){ return { ok: false, error: String(e) }; }
}
function makeNotificationPayload({ title, body, url, tag }) {
  return {
    data: {
      title: title || 'New message',
      body:  body  || 'You have a new message',
      url:   url   || '/chat-list.html',
      tag:   tag   || 'chat_inbox'
    }
  };
}

// ---- Netlify handler ----
exports.handler = async (event) => {
  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  try{
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers: corsHeaders(), body: 'Method Not Allowed' };
    }
    const headers = event.headers || {};
    const auth = headers.authorization || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) {
      return { statusCode: 401, headers: corsHeaders(), body: 'Missing bearer token' };
    }
    let decoded;
    try{
      decoded = await admin.auth().verifyIdToken(m[1]);
    }catch(e){
      return { statusCode: 401, headers: corsHeaders(), body: 'Invalid token' };
    }

    const body = JSON.parse(event.body || '{}');
    const { chatId, messageId } = body;
    if (!chatId || !messageId) {
      return { statusCode: 400, headers: corsHeaders(), body: 'chatId and messageId required' };
    }

    const msg = await getMessage(chatId, messageId);
    if (!msg) {
      return { statusCode: 404, headers: corsHeaders(), body: 'message not found' };
    }

    const senderUid = msg.senderId || decoded.uid;
    const recips = await getRecipients(chatId, senderUid);
    if (!recips.length) {
      return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ ok: true, sent: 0 }) };
    }

    const title = msg.senderName ? `${msg.senderName}` : 'New message';
    const bodyTxt  = msg.text ? msg.text.slice(0, 80) : 'Tap to view';
    const url   = `/chat.html?chatId=${encodeURIComponent(chatId)}`;
    const tag   = `chat_${chatId}`;
    const payload = makeNotificationPayload({ title, body: bodyTxt, url, tag });

    let totalTokens = [];
    let allEndpoints = [];
    for (const uid of recips) {
      const { tokens, endpoints } = await getUserTokens(uid);
      totalTokens = totalTokens.concat(tokens);
      allEndpoints = allEndpoints.concat(endpoints || []);
    }

    const fcmRes = await sendFCM(totalTokens, payload);
    const appRes = await sendAppilix(allEndpoints, title, bodyTxt, url);

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        ok: true,
        recipients: recips.length,
        fcmTokens: totalTokens.length,
        fcmResult: fcmRes,
        appilix: appRes
      })
    };
  }catch(e){
    console.error('notify error', e);
    return { statusCode: 500, headers: corsHeaders(), body: 'Internal error' };
  }
};
