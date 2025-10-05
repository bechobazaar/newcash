// netlify/functions/admin-list-chats.js
const { requireAdmin, initAdmin } = require('./_admin-utils');

exports.handler = async (event) => {
  const gate = await requireAdmin(event);
  if (!gate.ok) return { statusCode: gate.status, body: gate.msg };

  const admin = initAdmin();
  const db = admin.firestore();

  const requireEmails = String((event.queryStringParameters || {}).requireEmails || '1') === '1';

  try {
    // Simple list (no user-scoped restriction since Admin SDK)
    const snap = await db.collection('chats').limit(200).get();

    const rows = [];
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      const users = Array.isArray(data.users) ? data.users :
                    Array.isArray(data.participants) ? data.participants :
                    Array.isArray(data.members) ? data.members : [];

      if (users.length !== 2) continue;
      if (users.includes('admin') || users.includes(null) || users.includes(undefined)) continue;

      // fetch user emails
      const [u0, u1] = await Promise.all(users.map(uid => db.collection('users').doc(uid).get()));
      const e0 = u0.exists ? (u0.data().email || '').trim() : '';
      const e1 = u1.exists ? (u1.data().email || '').trim() : '';
      if (requireEmails && (!e0 || !e1)) continue;

      // last message preview
      let lastPreview = '';
      let lastTs = null;
      try {
        const last = await db.collection('chats').doc(doc.id).collection('messages')
          .orderBy('timestamp','desc').limit(1).get();
        const m = last.docs[0]?.data() || {};
        lastPreview = String(m.text || m.caption || '');
        lastTs = m.timestamp ? m.timestamp.toMillis() : null;
      } catch {}

      rows.push({
        chatId: doc.id,
        users,
        emails: [e0, e1],
        lastPreview,
        lastTs,
      });
    }

    // newest first
    rows.sort((a,b) => (b.lastTs||0) - (a.lastTs||0));

    return { statusCode: 200, body: JSON.stringify({ rows }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: 'server_error' };
  }
};
