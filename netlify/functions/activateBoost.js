const { db, auth, Timestamp, FieldValue } = require('./_firebaseAdmin');
const { resolvePlan, buildWeeklyTwoSchedule, computeNextBump, DAY_MS } = require('./_plans');

const okHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: okHeaders, body: '' };

  try {
    const { itemId, planCode } = JSON.parse(event.body || '{}');
    if (!itemId || !planCode) {
      return { statusCode: 400, headers: okHeaders, body: JSON.stringify({ error:'itemId and planCode required' }) };
    }

    // verify caller (Firebase ID token in Authorization: Bearer <token>) OR NETLIFY_BYPASS_TOKEN
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

    const plan = resolvePlan(planCode);
    if (!plan) return { statusCode:400, headers: okHeaders, body: JSON.stringify({ error:'Invalid planCode' }) };

    const ref = db.collection('items').doc(itemId);
    const snap = await ref.get();
    if (!snap.exists) return { statusCode:404, headers: okHeaders, body: JSON.stringify({ error:'Item not found' }) };

    const it = snap.data() || {};

    // only owner or admin
    if (uid !== 'admin' && uid !== it.userId) {
      return { statusCode:403, headers: okHeaders, body: JSON.stringify({ error:'Forbidden' }) };
    }
    if (it.status !== 'approved') {
      // allow even if pending? keep strict:
      return { statusCode:400, headers: okHeaders, body: JSON.stringify({ error:'Item not approved' }) };
    }

    const nowMs = Date.now();
    const startMs = nowMs;
    const endMs   = startMs + plan.days * DAY_MS;

    let bumpSchedule = [];
    if (plan.kind === 'WEEKLY2') {
      bumpSchedule = buildWeeklyTwoSchedule(startMs, plan.days);
    }

    // First bump happens NOW
    const nextBumpMs = computeNextBump(plan, startMs, startMs, endMs, bumpSchedule);

    await ref.set({
      boost: {
        plan: plan.code,
        active: true,
        startAt: Timestamp.fromMillis(startMs),
        endAt:   Timestamp.fromMillis(endMs),
        lastBumpedAt: Timestamp.fromMillis(startMs),
        nextBumpAt:    nextBumpMs ? Timestamp.fromMillis(nextBumpMs) : null,
        bumpsPerDay: (plan.kind === 'DAILY1') ? 1 : 0,
        bumpsDoneToday: (plan.kind === 'DAILY1') ? 1 : 0,
        bumpSchedule   // for WEEKLY2
      },
      // bump the listing to top instantly
      priorityScore: nowMs + Math.floor(Math.random() * 500)
    }, { merge: true });

    return { statusCode: 200, headers: okHeaders, body: JSON.stringify({ ok:true, nextBumpAt: nextBumpMs || null }) };

  } catch (e) {
    console.error('activateBoost error', e);
    return { statusCode: 500, headers: okHeaders, body: JSON.stringify({ error: 'Server error' }) };
  }
};
