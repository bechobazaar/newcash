// netlify/functions/notify-on-new-message.js
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp(); // Netlify env me GOOGLE_APPLICATION_CREDENTIALS set honi chahiye
}
const db = admin.firestore();
const messaging = admin.messaging();

const json = (code, body) => ({
  statusCode: code,
  headers: {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
  },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  try {
    const { chatId, messageId, targetUid, excludeUid } = JSON.parse(event.body || '{}');
    if (!chatId) return json(400, { error: 'chatId required' });

    // message / sender / preview
    const msgDoc = await db.collection('chats').doc(chatId)
      .collection('messages').doc(messageId).get().catch(()=>null);
    const msg = msgDoc && msgDoc.exists ? msgDoc.data() : {};
    const senderId = msg.senderId || excludeUid || null;

    // recipients
    let recipients = [];
    if (targetUid) {
      recipients = [targetUid];
    } else {
      const chatDoc = await db.collection('chats').doc(chatId).get();
      const users = chatDoc.exists ? (chatDoc.data().users || []) : [];
      recipients = users.filter(u => u && u !== senderId); // <<--- EXCLUDE SENDER
    }
    recipients = [...new Set(recipients)];

    if (!recipients.length) return json(200, { sent: 0, note: 'no recipients' });

    // collect FCM tokens only for recipients
    const tokens = [];
    for (const uid of recipients) {
      // aap save kar rahe ho: users/{uid}/fcmTokens/{token}
      const snap = await db.collection('users').doc(uid).collection('fcmTokens').get();
      snap.forEach(d => tokens.push(d.id || d.data()?.token));
    }
    const uniq = [...new Set(tokens)].filter(Boolean);
    if (!uniq.length) return json(200, { sent: 0, note: 'no tokens' });

    const title = 'New message';
    const body  = (msg.text && String(msg.text).slice(0, 80)) || 'You have a new message';
    const openLink = `https://bechobazaar.com/chat-list?open_conversation=${encodeURIComponent(chatId)}`;

    const payload = {
      notification: { title, body },
      data: { chatId, open_link_url: openLink }
    };

    const resp = await messaging.sendToDevice(uniq, payload, { priority: 'high' });
    return json(200, { sent: resp.successCount, fail: resp.failureCount });
  } catch (e) {
    return json(500, { error: e.message });
  }
};
