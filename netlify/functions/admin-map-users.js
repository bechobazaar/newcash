// netlify/functions/admin-map-users.js
const { requireAdmin, initAdmin } = require('./_admin-utils');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Use POST' };
  }

  const gate = await requireAdmin(event);
  if (!gate.ok) return { statusCode: gate.status, body: gate.msg };

  const admin = initAdmin();
  let uids = [];
  try {
    const body = JSON.parse(event.body || '{}');
    uids = Array.isArray(body.uids) ? body.uids.filter(Boolean) : [];
  } catch {}

  if (!uids.length) return { statusCode: 400, body: 'uids required' };

  try {
    // chunk upto 100 (getUsers limit)
    const chunks = [];
    for (let i=0; i<uids.length; i+=100) chunks.push(uids.slice(i, i+100));

    const map = {};
    for (const c of chunks) {
      const res = await admin.auth().getUsers(c.map(uid => ({ uid })));
      res.users.forEach(u => { map[u.uid] = u.email || ''; });
      // notFound users will be skipped (no email)
    }
    return { statusCode: 200, body: JSON.stringify({ map }) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: 'server_error' };
  }
};
