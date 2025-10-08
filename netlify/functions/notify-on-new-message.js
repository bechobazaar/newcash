// netlify/functions/notify-on-new-message.js
// Node18 + global fetch

const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    // Firestore URL if needed:
    // databaseURL: process.env.FB_DB_URL
  });
}
const db = admin.firestore();

const FCM_KEY = process.env.FCM_SERVER_KEY; // <- set in Netlify env

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // optional auth check (recommended)
  const auth = event.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return { statusCode: 401, body: 'Missing token' };
  }
  try { await admin.auth().verifyIdToken(auth.slice(7)); }
  catch { return { statusCode: 401, body: 'Invalid token' }; }

  try {
    const { chatId, messageId, recipientUid } = JSON.parse(event.body || '{}');
    if (!chatId || !messageId) {
      return { statusCode: 400, body: 'chatId & messageId required' };
    }
    if (!FCM_KEY) {
      return { statusCode: 500, body: 'FCM_SERVER_KEY missing' };
    }

    // --- Load message (to know senderId & text)
    const msgDoc = await db.collection('chats').doc(chatId)
      .collection('messages').doc(messageId).get();
    if (!msgDoc.exists) return { statusCode: 404, body: 'message not found' };
    const msg = msgDoc.data() || {};
    const senderId = msg.senderId;

    // --- Compute recipients
    let recipients = [];
    if (recipientUid) {
      // client ne explicitly bola kisey push deni hai
      if (recipientUid !== senderId) recipients = [recipientUid];
    } else {
      // chat doc se nikalo, sender ko exclude
      const chatDoc = await db.collection('chats').doc(chatId).get();
      const users = (chatDoc.data()?.users || []).filter(u => u && u !== senderId);
      recipients = [...new Set(users)];
    }
    if (!recipients.length) {
      return { statusCode: 200, body: JSON.stringify({ ok:true, sent:0, note:'no recipients' }) };
    }

    // --- Collect ONLY recipients’ FCM tokens
    const tokens = new Set();
    for (const uid of recipients) {
      const snap = await db.collection('users').doc(uid).collection('fcmTokens').get();
      snap.forEach(d => {
        const t = d.id || d.data()?.token;
        if (t) tokens.add(String(t));
      });
      // (optional) include web push/fcm_web stored in pushEndpoints
      const ep = await db.collection('users').doc(uid)
        .collection('pushEndpoints')
        .where('type', 'in', ['fcm_web', 'fcm'])
        .get();
      ep.forEach(d => { const t = d.data()?.token; if (t) tokens.add(String(t)); });
    }

    const tokenList = [...tokens];
    if (tokenList.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ ok:true, sent:0, note:'no tokens' }) };
    }

    // --- Build FCM payload
    const bodyText = (msg.text && msg.text.trim()) ? msg.text.trim() : 'New message received';
    const openLink = `https://bechobazaar.com/chat-list?open_conversation=${encodeURIComponent(chatId)}`;

    const payload = {
      registration_ids: tokenList,
      notification: {
        title: 'New message',
        body: bodyText,
        click_action: openLink,        // web
      },
      data: {
        open_link_url: openLink,       // native/web both
        chat_id: chatId,
        message_id: messageId,
        type: 'chat_new_message'
      },
      android: { priority: 'high' },
      priority: 'high'
    };

    const res = await fetch('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `key=${FCM_KEY}`
      },
      body: JSON.stringify(payload)
    });

    const txt = await res.text();
    return {
      statusCode: 200,
      body: JSON.stringify({ ok:true, status: res.status, recipients, tokens: tokenList.length, fcm: txt })
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok:false, error: String(e) }) };
  }
};
