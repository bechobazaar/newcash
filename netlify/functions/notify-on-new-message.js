// netlify/functions/notify-on-new-message.js
const ALLOWED_ORIGINS = new Set([
  'https://bechobazaar.com',
  'https://www.bechobazaar.com',
  'http://localhost:3000',
  'http://localhost:5173',
]);
function corsHeaders(origin){
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://bechobazaar.com';
  return {
    'Access-Control-Allow-Origin': allow,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

const admin = require('firebase-admin');
function svcFromEnv(){
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if(!b64) throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 not set');
  const json = Buffer.from(b64,'base64').toString('utf8');
  const svc  = JSON.parse(json);
  if (svc.private_key?.includes('\\n')) svc.private_key = svc.private_key.replace(/\\n/g,'\n');
  return svc;
}
if(!admin.apps.length){
  const svc = svcFromEnv();
  admin.initializeApp({ credential: admin.credential.cert(svc), projectId: svc.project_id || 'olxhub-12479' });
  console.log('Admin project:', admin.app().options.projectId);
}
const db = admin.firestore();

exports.handler = async (event)=>{
  const headers = corsHeaders(event.headers?.origin||'');
  if (event.httpMethod==='OPTIONS') return {statusCode:204, headers, body:''};
  if (event.httpMethod!=='POST')   return {statusCode:405, headers, body:'Method Not Allowed'};

  try{
    // auth
    const authz = event.headers?.authorization||'';
    if(!/^Bearer\s.+/.test(authz)) return {statusCode:401, headers, body:'Missing Authorization'};
    let decoded; try{ decoded = await admin.auth().verifyIdToken(authz.replace(/^Bearer\s+/,'')); }
    catch{ return {statusCode:401, headers, body:'Invalid token'}; }
    const senderUid = decoded.uid;

    // body
    const { chatId, messageId, previewText } = JSON.parse(event.body||'{}');
    if(!chatId || !messageId) return {statusCode:400, headers, body:'chatId & messageId required'};

    // recipient
    const chatDoc = await db.collection('chats').doc(chatId).get();
    if(!chatDoc.exists) return {statusCode:404, headers, body:'Chat not found'};
    const users = Array.isArray(chatDoc.data().users) ? chatDoc.data().users : [];
    const recipientUid = users.find(u=>u!==senderUid);
    if(!recipientUid) return {statusCode:400, headers, body:'Recipient not found'};

    // web tokens
    const fcmSnap = await db.collection('users').doc(recipientUid).collection('fcmTokens').get();
    const webTokens = [];
    fcmSnap.forEach(d => {
      const tok = d.id || d.data()?.token;
      if (tok) webTokens.push(tok);
    });

    // ANDROID native tokens saved in pushEndpoints
    const peSnap = await db.collection('users').doc(recipientUid).collection('pushEndpoints')
      .where('type','==','native')
      .where('platform','==','android')
      .get();
    const nativeAndroidTokens = [];
    peSnap.forEach(d=>{
      const t = d.data()?.token;
      // FCM native registration tokens generally like "xxxx:APA91..."
      if (t && /:APA91/.test(t)) nativeAndroidTokens.push(t);
    });

    // merge + dedupe
    const tokens = Array.from(new Set([...webTokens, ...nativeAndroidTokens]));
    if(!tokens.length) return {statusCode:200, headers, body:JSON.stringify({ok:true, sent:0, fail:0, reason:'no-tokens'})};

    // message
    const openUrl = `https://bechobazaar.com/chat-list?open_conversation=${encodeURIComponent(chatId)}`;
    const multicast = {
      tokens,
      data: {
        title:'New message',
        body: (previewText?.trim()) || 'New message received',
        chatId, messageId,
        open_link_url: openUrl, click_action: openUrl,
      },
      webpush: { fcm_options:{ link: openUrl }, headers:{ Urgency:'high' } },
    };

    // send
    const resp = await admin.messaging().sendEachForMulticast(multicast);

    // error report
    const errors = [];
    resp.responses.forEach((r,i)=>{ if(!r.success){ errors.push({ token: tokens[i], code: r.error?.code||null, msg: r.error?.message||null }); }});

    // cleanup invalid/expired
    const bad = [];
    resp.responses.forEach((r,i)=>{
      const code = r.error?.code || '';
      if (!r.success && (
          code==='messaging/registration-token-not-registered' ||
          code==='messaging/invalid-registration-token'       ||
          code==='messaging/third-party-auth-error'
      )) bad.push(tokens[i]);
    });
    if (bad.length){
      // try delete from fcmTokens
      const batch = db.batch();
      bad.forEach(tk => batch.delete(db.collection('users').doc(recipientUid).collection('fcmTokens').doc(tk)));
      await batch.commit().catch(()=>{});
      // also try delete from pushEndpoints (android native)
      const pe = await db.collection('users').doc(recipientUid).collection('pushEndpoints')
        .where('type','==','native').where('platform','==','android').get();
      const batch2 = db.batch();
      pe.forEach(doc=>{
        if (bad.includes(doc.data()?.token)) batch2.delete(doc.ref);
      });
      await batch2.commit().catch(()=>{});
    }

    // optimistic delivered
    try{ await db.collection('chats').doc(chatId).collection('messages').doc(messageId).set({delivered:true},{merge:true}); }catch{}

    return { statusCode:200, headers, body: JSON.stringify({ ok:true, sent: resp.successCount||0, fail: resp.failureCount||0, errors }) };
  }catch(e){
    return { statusCode:500, headers, body: JSON.stringify({ ok:false, error:String(e?.message||e) }) };
  }
};
