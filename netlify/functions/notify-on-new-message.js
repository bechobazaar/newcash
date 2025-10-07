const admin = require('firebase-admin');
const { sendAppilixPush } = require('./_lib/appilix');

function initAdmin(){
  if (!admin.apps.length){
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    const obj = JSON.parse(Buffer.from(b64.trim(),'base64').toString('utf8'));
    if (obj.private_key) obj.private_key = obj.private_key.replace(/\\n/g,'\n');
    admin.initializeApp({ credential: admin.credential.cert(obj) });
  }
}
const chunk=(a,n)=>{const o=[];for(let i=0;i<a.length;i+=n)o.push(a.slice(i,i+n));return o;};
const safeChatTitleBody=()=>({ title:'New message received', body:'' });

exports.handler = async (event) => {
  initAdmin();
  const db = admin.firestore();
  if (event.httpMethod==='OPTIONS') return { statusCode:204, headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'POST,OPTIONS'}, body:'' };
  if (event.httpMethod!=='POST') return { statusCode:405, body:'Method Not Allowed' };

  try{
    const auth = event.headers.authorization || event.headers.Authorization || '';
    if (!auth.startsWith('Bearer ')) return { statusCode:401, body:'Unauthorized' };
    const decoded = await admin.auth().verifyIdToken(auth.slice(7));

    const { chatId, messageId, linkOverride } = JSON.parse(event.body||'{}');
    if (!chatId || !messageId) return { statusCode:400, body:'chatId and messageId required' };

    // chat + message
    const chatRef = db.collection('chats').doc(chatId);
    const chatDoc = await chatRef.get(); if (!chatDoc.exists) return { statusCode:404, body:'Chat not found' };
    const users = chatDoc.get('users') || [];
    if (!users.includes(decoded.uid)) return { statusCode:403, body:'Not in chat' };

    const msgSnap = await chatRef.collection('messages').doc(messageId).get();
    if (!msgSnap.exists) return { statusCode:404, body:'Message not found' };
    const m = msgSnap.data()||{};
    const recipients = users.filter(u=>u!==m.senderId);
    if (!recipients.length) return { statusCode:200, body:JSON.stringify({reason:'no recipients'}) };

    // tokens
    const tokenSet = new Set();
    await Promise.all(recipients.map(async (uid)=>{
      const base = db.collection('users').doc(uid);
      const [t1,t2] = await Promise.all([
        base.collection('fcmTokens').get(),
        base.collection('pushEndpoints').where('type','in',['fcm_web','native']).get()
      ]);
      t1.forEach(d=>d.id && tokenSet.add(d.id));
      t2.forEach(d=>{const x=d.data()||{}; if(x.token) tokenSet.add(x.token);});
    }));
    const tokens = Array.from(tokenSet);

    const site = (process.env.APP_BASE_URL || 'https://bechobazaar.com').replace(/\/$/,'');
    const link = linkOverride || `${site}/chat-list.html`;
    const tag = chatId ? `chat_${chatId}` : 'chat_inbox';
    const { title, body } = safeChatTitleBody();

    // ---- FCM (data-only) ----
    let fcm = { sent:0, failed:0 };
    if (tokens.length){
      const msg = {
        data: {
          ch:'fcm', kind:'chat', title, body, url:link, tag,
          chatId:String(chatId), messageId:String(messageId), senderId:String(m.senderId||'')
        },
        webpush: { fcmOptions:{ link }, headers:{ Urgency:'high', TTL:'600' } },
        android: { priority:'high', collapseKey:tag },
        apns: { headers:{ 'apns-priority':'10' } }
      };
      for (const part of chunk(tokens, 500)){
        const res = await admin.messaging().sendEachForMulticast({...msg, tokens:part});
        fcm.sent += res.successCount; fcm.failed += res.failureCount;
      }
    }

    // ---- Appilix (APK) ----
    let appilix = [];
    if (process.env.APPILIX_APP_KEY && process.env.APPILIX_API_KEY){
      appilix = await Promise.all(recipients.map(uid =>
        sendAppilixPush({
          appKey: process.env.APPILIX_APP_KEY,
          apiKey: process.env.APPILIX_API_KEY,
          title, body, user_identity: uid, open_link_url: link
        }).catch(e=>({ ok:false, error:e.message, uid }))
      ));
    }

    return { statusCode:200, headers:{'Cache-Control':'no-store','Access-Control-Allow-Origin':'*'}, body: JSON.stringify({ fcm, appilix }) };
  }catch(e){
    console.error('notify-on-new-message error', e);
    return { statusCode:500, body:'Internal Server Error' };
  }
};
