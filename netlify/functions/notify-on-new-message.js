// netlify/functions/notify-on-new-message.js
// Node 18 runtime

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    // Netlify env me GOOGLE_APPLICATION_CREDENTIALS / default creds use honge
  });
}

const db = admin.firestore();

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors() };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors(), body: 'Method Not Allowed' };
  }

  try {
    const auth = event.headers.authorization || '';
    const token = (auth.startsWith('Bearer ') ? auth.slice(7) : '').trim();
    let senderUid = null;
    if (token) {
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        senderUid = decoded.uid;
      } catch (_) {}
    }

    const { chatId, messageId, recipientUid: recipientFromClient } = JSON.parse(event.body || '{}');
    if (!chatId || !messageId) {
      return json({ ok:false, error:'chatId/messageId missing' });
    }

    // message read → senderId nikaal lo
    const mRef  = db.collection('chats').doc(chatId).collection('messages').doc(messageId);
    const mSnap = await mRef.get();
    const m = mSnap.exists ? mSnap.data() : {};
    const msgSender = m.senderId || senderUid || null;

    // chat read → users[] me se recipient nikaalo
    const cSnap = await db.collection('chats').doc(chatId).get();
    const users = cSnap.exists ? (cSnap.data().users || []) : [];
    let recipientUid = recipientFromClient || users.find(u => u && u !== msgSender);

    if (!recipientUid) {
      return json({ ok:false, error:'recipient not resolved' });
    }
    if (recipientUid === msgSender) {
      // safety: kabhi sender ko mat bhejna
      return json({ ok:true, skipped:'self' });
    }

    // tokens pick (sirf recipient ke)
    const tokenSet = new Set();

    // legacy collection: users/{uid}/fcmTokens (doc ids = token)
    const t1 = await db.collection('users').doc(recipientUid).collection('fcmTokens').get();
    t1.forEach(d => { const t = (d.id || '').trim(); if (t) tokenSet.add(t); });

    // new style: users/{uid}/pushEndpoints where type == 'fcm_web'
    const t2 = await db.collection('users').doc(recipientUid).collection('pushEndpoints')
      .where('type', '==', 'fcm_web').get();
    t2.forEach(d => { const t = (d.data().token || '').trim(); if (t) tokenSet.add(t); });

    const tokens = Array.from(tokenSet);
    if (!tokens.length) {
      return json({ ok:false, error:'no fcm tokens for recipient' });
    }

    // payload
    const preview = (m.text || '').trim() ? m.text.trim().slice(0, 120) : 'New message received';
    const openLink = `https://bechobazaar.com/chat-list?open_conversation=${encodeURIComponent(chatId)}`;

    const payload = {
      notification: {
        title: 'New message',
        body: preview,
      },
      data: {
        click_action: 'FLUTTER_NOTIFICATION_CLICK',
        open_link_url: openLink,
        chat_id: chatId,
        message_id: messageId,
        recipient_uid: recipientUid
      }
    };

    const resp = await admin.messaging().sendToDevice(tokens, payload, {
      priority: 'high',
      timeToLive: 60 * 60,
    });

    // mark delivered on success (optional)
    try {
      const success = (resp.results || []).some(r => !r.error);
      if (success) await mRef.set({ delivered: true, status: 'delivered' }, { merge: true });
    } catch (_) {}

    return json({ ok:true, sent: tokens.length });
  } catch (e) {
    console.error(e);
    return { statusCode: 500, headers: cors(), body: e.message || 'Error' };
  }
};

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}
function json(obj) {
  return { statusCode: 200, headers: cors(), body: JSON.stringify(obj) };
}
