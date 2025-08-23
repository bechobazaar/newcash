const { db, auth, Timestamp } = require('./_firebaseAdmin');

const okHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Bypass-Token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: okHeaders, body: '' };

  try {
    const { itemId } = JSON.parse(event.body || '{}');
    if (!itemId) return { statusCode: 400, headers: okHeaders, body: JSON.stringify({ error:'itemId required' }) };

    const authz = event.headers.authorization || '';
    const bypass = event.headers['x-bypass-token'] || '';
    let uid = null;

    if (bypass && bypass === process.env.BYPASS_TOKEN) {
      uid = 'admin';
    } else if (authz.startsWith('Bearer ')) {
      const token = authz.slice(7);
      const decoded = await auth.verifyIdToken(token);
      uid = decoded.uid;
    } else {
      return { statusCode: 401, headers: okHeaders, body: JSON.stringify({ error:'Unauthorized' }) };
    }

    const ref = db.collection('items').doc(itemId);
    const snap = await ref.get();
    if (!snap.exists) return { statusCode:404, headers: okHeaders, body: JSON.stringify({ error:'Not found' }) };

    const it = snap.data() || {};
    if (uid !== 'admin' && uid !== it.userId) {
      return { statusCode:403, headers: okHeaders, body: JSON.stringify({ error:'Forbidden' }) };
    }

    const now = Date.now();
    await ref.update({
      priorityScore: now + Math.floor(Math.random() * 500),
      'boost.lastBumpedAt': Timestamp.fromMillis(now)
    });

    return { statusCode:200, headers: okHeaders, body: JSON.stringify({ ok:true }) };
  } catch (e) {
    console.error('bumpNow error', e);
    return { statusCode:500, headers: okHeaders, body: JSON.stringify({ error:'Server error' }) };
  }
};
