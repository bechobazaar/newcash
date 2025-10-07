const admin = require('firebase-admin');

function initAdmin() {
  if (!admin.apps.length) {
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    if (!b64) throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 missing');
    const obj = JSON.parse(Buffer.from(b64.trim(), 'base64').toString('utf8'));
    if (obj.private_key) obj.private_key = obj.private_key.replace(/\\n/g, '\n');
    admin.initializeApp({ credential: admin.credential.cert(obj) });
  }
}
function parseOrigins(csv){ return String(csv || '').split(',').map(s=>s.trim()).filter(Boolean); }
function pickOrigin(event){
  const allowed = parseOrigins(process.env.ALLOWED_ORIGINS);
  const hdr = event.headers || {};
  const o = hdr.origin || hdr.Origin || (hdr.host ? `https://${hdr.host}` : '');
  const base = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  return allowed.includes(o) ? o : (base || allowed[0] || '*');
}
function buildSafeTitleBodyForChat(){ return { title:'New message received', body:'' }; }
function chunk(arr, size){ const out=[]; for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i,i+size)); return out; }

exports.handler = async (event) => {
  initAdmin();
  const db = admin.firestore();

  const ORIGIN = pickOrigin(event);
  const cors = {
    'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
    'Cache-Control': 'no-store'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  try {
    const auth = event.headers.authorization || event.headers.Authorization || '';
    if (!auth.startsWith('Bearer ')) return { statusCode: 401, headers: cors, body: 'Unauthorized' };
    const decoded = await admin.auth().verifyIdToken(auth.slice(7));

    const q = new URLSearchParams(event.queryStringParameters || {});
    const dryRun = q.get('dryRun') === '1';

    const { chatId, messageId, linkOverride } = JSON.parse(event.body || '{}');
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
    if (!recipients.length) return { statusCode: 200, headers: cors, body: JSON.stringify({ sent:0, failed:0, reason:'No recipients' }) };

    const tokenSet = new Set();
    const tokenOwners = new Map();

    await Promise.all(recipients.map(async (uid) => {
      const base = db.collection('users').doc(uid);
      const [t1, t2] = await Promise.all([
        base.collection('fcmTokens').get(),
        base.collection('pushEndpoints').where('type', 'in', ['fcm_web','native']).get()
      ]);
      t1.forEach(d => { const tok=d.id; if(tok){ tokenSet.add(tok); (tokenOwners.get(tok)||tokenOwners.set(tok,new Set()).get(tok)).add(uid); }});
      t2.forEach(d => { const x=d.data()||{}; const tok=x.token; if(tok){ tokenSet.add(tok); (tokenOwners.get(tok)||tokenOwners.set(tok,new Set()).get(tok)).add(uid); }});
    }));

    const tokens = Array.from(tokenSet);
    if (!tokens.length) return { statusCode: 200, headers: cors, body: JSON.stringify({ sent:0, failed:0, reason:'No device tokens' }) };

    const site = (process.env.APP_BASE_URL || 'https://bechobazaar.com').replace(/\/$/,'');
    const link = linkOverride || `${site}/chat-list.html`;
    const tag  = chatId ? `chat_${chatId}` : 'chat_inbox';
    const { title, body } = buildSafeTitleBodyForChat();

    const baseMsg = {
      data: {
        title, body, url: link, tag,
        ch: 'fcm',
        kind: 'chat',
        chatId: String(chatId),
        senderId: String(m.senderId || ''),
        messageId: String(messageId)
      },
      webpush: { fcmOptions: { link }, headers: { Urgency: 'high', TTL: '600' } },
      android: { priority: 'high', collapseKey: tag },
      apns: { headers: { 'apns-priority': '10' } }
    };

    const batches = chunk(tokens, 500);
    let sent=0, failed=0, cleaned=0;

    for (const batch of batches) {
      const msg = { ...baseMsg, tokens: batch };
      const res = dryRun
        ? { successCount: batch.length, failureCount: 0, responses: batch.map(()=>({success:true})) }
        : await admin.messaging().sendEachForMulticast(msg);

      sent += res.successCount || 0;
      failed += res.failureCount || 0;

      if (!dryRun) {
        for (let i=0;i<res.responses.length;i++){
          const r = res.responses[i];
          if (r && !r.success) {
            const code = r.error?.code || '';
            const isBad = code.includes('registration-token-not-registered') ||
                          code.includes('invalid-argument') ||
                          code.includes('messaging/registration-token-not-registered');
            if (isBad) {
              const bad = batch[i];
              const owners = Array.from((tokenOwners.get(bad) || new Set()));
              await Promise.all(owners.map(async (uid) => {
                try {
                  await db.collection('users').doc(uid).collection('fcmTokens').doc(bad).delete().catch(()=>{});
                  const qs = await db.collection('users').doc(uid).collection('pushEndpoints').where('token','==',bad).get();
                  const dels=[]; qs.forEach(d => dels.push(d.ref.delete().catch(()=>{})));
                  await Promise.all(dels);
                } catch {}
              }));
              cleaned += 1;
            }
          }
        }
      }
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify({ sent, failed, cleaned, tokens: tokens.length, recipients: recipients.length, batches: batches.length, dryRun }) };
  } catch (e) {
    console.error('notify-on-new-message error', e);
    return { statusCode: 500, headers: cors, body: 'Internal Server Error' };
  }
};
