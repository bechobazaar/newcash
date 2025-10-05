// netlify/functions/admin-get-messages.js
const { requireAdmin, initAdmin } = require('./_admin-utils');

exports.handler = async (event) => {
  const gate = await requireAdmin(event);
  if (!gate.ok) return { statusCode: gate.status, body: gate.msg };

  const chatId = (event.queryStringParameters || {}).chatId || '';
  if (!chatId) return { statusCode: 400, body: 'chatId required' };

  const admin = initAdmin();
  const db = admin.firestore();

  try {
    const chat = await db.collection('chats').doc(chatId).get();
    if (!chat.exists) return { statusCode: 404, body: 'not_found' };

    const users = Array.isArray(chat.data().users) ? chat.data().users :
                  Array.isArray(chat.data().participants) ? chat.data().participants :
                  Array.isArray(chat.data().members) ? chat.data().members : [];

    // map emails
    const [u0, u1] = await Promise.all(users.map(uid => db.collection('users').doc(uid).get()));
    const emails = [
      u0.exists ? (u0.data().email || '') : '',
      u1.exists ? (u1.data().email || '') : ''
    ];

    const snap = await db.collection('chats').doc(chatId).collection('messages')
      .orderBy('timestamp').get();

    const msgs = snap.docs.map(d => {
      const m = d.data() || {};
      return {
        id: d.id,
        senderId: m.sender ?? m.senderId ?? m.userId ?? m.uid ?? m.from ?? 'unknown',
        text: m.text || '',
        caption: m.caption || m.message || '',
        imageUrl: m.imageUrl || null,
        imageUrls: Array.isArray(m.imageUrls) ? m.imageUrls : [],
        timestamp: m.timestamp ? m.timestamp.toMillis() : null,
        status: m.status || '',
        delivered: !!m.delivered,
        seen: !!m.seen
      };
    });

    return { statusCode: 200, body: JSON.stringify({ users, emails, msgs }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: 'server_error' };
  }
};
