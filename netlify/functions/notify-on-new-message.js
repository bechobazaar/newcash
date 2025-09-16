// /.netlify/functions/notify-on-new-message.js
const admin = require('firebase-admin');

function initAdmin() {
  if (!admin.apps.length) {
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    const obj = JSON.parse(Buffer.from(b64.trim(), 'base64').toString('utf8'));
    if (obj.private_key) obj.private_key = obj.private_key.replace(/\\n/g, '\n');
    admin.initializeApp({ credential: admin.credential.cert(obj) });
  }
}
function parseOrigins(csv){
  return String(csv || '').split(',').map(s=>s.trim()).filter(Boolean);
}
function pickOrigin(event){
  const allowed = parseOrigins(process.env.ALLOWED_ORIGINS) || [];
  const hdr = event.headers || {};
  const o = hdr.origin || hdr.Origin || (hdr.host ? `https://${hdr.host}` : '');
  const base = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  if (allowed.includes(o)) return o;
  return base || allowed[0] || '*';
}
function buildSnippet(m = {}) {
  const type = (m.type || '').toLowerCase();
  const text = String(m.text || m.caption || '').replace(/\s+/g,' ').trim();
  const trunc = (s,n=90)=> s.length>n ? s.slice(0,n-1)+'…' : s;
  if (type === 'offer') return '💬 New offer';
  if (type === 'image') return text ? `📷 ${trunc(text)}` : '📷 Photo';
  if (type === 'file')  return text ? `📎 ${trunc(text)}` : '📎 File';
  if (type === 'phone_shared') return '☎️ Phone number shared';
  if (type === 'location')     return '📍 Location shared';
  return text || 'New message';
}

exports.handler = async (event) => {
  initAdmin();
  const db = admin.firestore();

  const ORIGIN = pickOrigin(event);
  const cors = {
    'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  try {
    const auth = event.headers.authorization || event.headers.Authorization || '';
    if (!auth.startsWith('Bearer ')) return { statusCode: 401, headers: cors, body: 'Unauthorized' };
    const decoded = await admin.auth().verifyIdToken(auth.slice(7));

    const { chatId, messageId } = JSON.parse(event.body || '{}');
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

    // Build deep link (list safer; change to /chat?chatId=... if needed)
    const site = (process.env.APP_BASE_URL || 'https://bechobazaar.com').replace(/\/$/, '');
    const link = `${site}/chat-list.html`;
    const title = 'New message received';
    const body  = buildSnippet(m);
    const tag   = chatId ? `chat_${chatId}` : 'chat_inbox';

    // Collect tokens (legacy + unified) for all recipients; dedupe
    const tokens = new Set();
    for (const uid of recipients) {
      const t1 = await db.collection('users').doc(uid).collection('fcmTokens').get();
      t1.forEach(d => d.id && tokens.add(d.id));
      const t2 = await db.collection('users').doc(uid).collection('pushEndpoints')
        .where('type','in',['fcm_web','native']).get();
      t2.forEach(d => { const x=d.data()||{}; if (x.token) tokens.add(x.token); });
    }
    const arr = Array.from(tokens);
    let success = 0, failed = 0;

    if (arr.length){
      const msg = {
        tokens: arr,
        // ✅ DATA-ONLY
        data: { title, body, url: link, tag, ch: 'fcm', chatId, senderId: String(m.senderId || ''), messageId: String(messageId) },
        webpush: { fcmOptions: { link }, headers: { Urgency:'high', TTL:'600' } },
        android: { priority:'high' },
        apns: { headers: { 'apns-priority':'10' } }
      };
      const res = await admin.messaging().sendEachForMulticast(msg);
      success += res.successCount; failed += res.failureCount;

      // cleanup invalids
      for (let i=0;i<res.responses.length;i++){
        const r = res.responses[i];
        if (!r.success) {
          const code = r.error?.code || '';
          if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
            const bad = arr[i];
            for (const uid of recipients) {
              try {
                await db.collection('users').doc(uid).collection('fcmTokens').doc(bad).delete().catch(()=>{});
                const qs = await db.collection('users').doc(uid).collection('pushEndpoints').where('token','==',bad).get();
                qs.forEach(d => d.ref.delete().catch(()=>{}));
              } catch {}
            }
          }
        }
      }
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify({ sent: success, failed }) };
  } catch (e) {
    console.error('notify-on-new-message error', e);
    return { statusCode: 500, headers: cors, body: 'Internal Server Error' };
  }
};
