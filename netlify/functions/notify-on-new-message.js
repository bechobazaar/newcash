// netlify/functions/notify-on-new-message.js
const admin = require('firebase-admin');
const fetch = global.fetch;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(), // Netlify env me GOOGLE_APPLICATION_CREDENTIALS set hona chahiye
  });
}
const db = admin.firestore();

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return resp(204, null);

    // Optional: verify Firebase ID token from Authorization header (Bearer …) if you want
    const { chatId, messageId } = JSON.parse(event.body || '{}');
    if (!chatId || !messageId) return resp(400, { ok:false, error:'chatId/messageId missing' });

    // Chat + message fetch
    const chatRef = db.collection('chats').doc(chatId);
    const chat = (await chatRef.get()).data() || {};
    const msg  = (await chatRef.collection('messages').doc(messageId).get()).data() || {};

    const sender = msg.senderId;
    const [a,b]  = chat.users || [];
    const recipientUid = (a === sender) ? b : a;

    if (!recipientUid) return resp(400, { ok:false, error:'recipient not resolved' });

    // Construct open link (Appilix will open this)
    const openLink = `https://bechobazaar.com/chat-list?open_conversation=${encodeURIComponent(chatId)}`;
    const preview  = (msg.text && msg.text.trim()) || 'New message received';

    // ---- Try Appilix targeted first
    const appilixRes = await fetch(process.env.SEND_APPILIX_PUSH_URL /* set env to the function URL */, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        user_identity: recipientUid,
        title:'New message',
        message: preview,
        open_link_url: openLink
      })
    });
    const appilixText = await appilixRes.text();
    let appilixOK = false;
    try { appilixOK = JSON.parse(appilixText)?.ok === true && /"status"\s*:\s*"true"/i.test(appilixText); } catch {}

    if (appilixOK) {
      // mark delivered flag quickly
      await chatRef.collection('messages').doc(messageId).set({ delivered:true }, { merge:true });
      return resp(200, { ok:true, via:'appilix', result:appilixText });
    }

    // ---- Fallback: FCM only to recipient's saved tokens (native/web)
    const tokens = new Set();

    // legacy web FCM tokens (if you already save under users/{uid}/fcmTokens)
    const fcmSnap = await db.collection('users').doc(recipientUid).collection('fcmTokens').get();
    fcmSnap.forEach(d => d.exists && d.data()?.token && tokens.add(d.data().token));

    // endpoints collection (we saved in frontend) — you can also mirror native tokens to FCM if applicable
    const endSnap = await db.collection('users').doc(recipientUid).collection('pushEndpoints').get();
    endSnap.forEach(d=>{
      const x = d.data() || {};
      // If you also store FCM web tokens here you can add them similarly.
      if (x.type === 'fcm_web' && x.token) tokens.add(x.token);
    });

    if (!tokens.size) return resp(200, { ok:false, via:'none', reason:'no-tokens' });

    const payload = {
      notification: { title:'New message', body: preview },
      data: {
        chatId, messageId,
        open_link_url: openLink
      }
    };
    const result = await admin.messaging().sendToDevice([...tokens], payload, { priority:'high' });

    await chatRef.collection('messages').doc(messageId).set({ delivered:true }, { merge:true });

    return resp(200, { ok:true, via:'fcm', result });
  } catch (e) {
    return resp(500, { ok:false, error:String(e) });
  }
};

function resp(code, body){
  return {
    statusCode: code,
    headers:{
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Methods':'POST,OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type,Authorization',
      'Content-Type':'application/json'
    },
    body: body==null ? '' : JSON.stringify(body)
  };
}
