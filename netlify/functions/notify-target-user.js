// netlify/functions/notify-target-user.js
// Sends FCM **only** to the given toUid (no broadcast).

const admin = require('firebase-admin');

if (!admin.apps.length) {
  // Make sure you have GOOGLE_APPLICATION_CREDENTIALS set in Netlify env
  admin.initializeApp();
}
const db = admin.firestore();

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    let senderUid = null;
    if (authHeader.startsWith('Bearer ')) {
      const idToken = authHeader.slice(7);
      try {
        const decoded = await admin.auth().verifyIdToken(idToken);
        senderUid = decoded.uid || null;
      } catch (_) { /* ignore */ }
    }

    const payload = JSON.parse(event.body || '{}');
    const toUid = String(payload.toUid || '').trim();
    const title = String(payload.title || 'New message');
    const body  = String(payload.body  || 'Message received');
    const link  = String(payload.open_link_url || 'https://bechobazaar.com/chat-list');

    if (!toUid) {
      return { statusCode: 400, body: JSON.stringify({ ok:false, error: 'toUid required' }) };
    }
    // Safety: never send to self
    if (senderUid && senderUid === toUid) {
      return { statusCode: 204, body: '' };
    }

    // Collect device tokens ONLY for toUid
    const tokens = new Set();

    // 1) legacy fcmTokens collection
    const fcmCol = await db.collection('users').doc(toUid).collection('fcmTokens').get();
    fcmCol.forEach(d => {
      const t = (d.data() || {}).token;
      if (t) tokens.add(t);
    });

    // 2) pushEndpoints (keep only fcm_web)
    const peCol = await db.collection('users').doc(toUid).collection('pushEndpoints').get();
    peCol.forEach(d => {
      const data = d.data() || {};
      if (data.type === 'fcm_web' && data.token) tokens.add(data.token);
      // (optional) If you also store native FCM tokens here, include them too
      if (data.type === 'native' && data.token) tokens.add(data.token);
    });

    if (!tokens.size) {
      return { statusCode: 200, body: JSON.stringify({ ok:true, sent:0, reason:'no-tokens' }) };
    }

    const message = {
      notification: { title, body },
      webpush: {
        fcmOptions: { link }
      },
      data: {
        click_action: link,
        open_link_url: link,
        kind: 'chat_message'
      },
      tokens: Array.from(tokens)
    };

    const resp = await admin.messaging().sendMulticast(message);
    return {
      statusCode: 200,
      body: JSON.stringify({ ok:true, successCount: resp.successCount, failureCount: resp.failureCount })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ ok:false, error: String(err) }) };
  }
};
