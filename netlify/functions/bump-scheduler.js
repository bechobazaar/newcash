// netlify/functions/bump-scheduler.js
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const svc = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'));
  admin.initializeApp({ credential: admin.credential.cert(svc) });
}
const db = admin.firestore();

const DAY_MS  = 24*60*60*1000;
const HOUR_MS = 60*60*1000;

// Every 5 minutes
exports.config = { schedule: '*/5 * * * *' };

exports.handler = async () => {
  const now = Date.now();
  const dueSnap = await db.collection('items')
    .where('boostPlan.active', '==', true)
    .where('boostPlan.nextBumpAt', '<=', now)
    .limit(300)
    .get();

  if (dueSnap.empty) return { statusCode: 200, body: JSON.stringify({ bumped: 0 }) };

  const batch = db.batch();
  let bumped = 0;

  for (const doc of dueSnap.docs) {
    const it = doc.data();
    const ref = doc.ref;

    // expire end
    if (it.featuredExpiry && it.featuredExpiry <= now) {
      batch.set(ref, { featured: false, 'boostPlan.active': false, 'boostPlan.nextBumpAt': null }, { merge: true });
      continue;
    }

    // sirf approved ads ko bump karo (takki hidden/pending na aaye top)
    if (it.status && it.status !== 'approved') continue;

    const updates = { bumpAt: now };

    const plan = String(it?.boostPlan?.plan || '');
    if (plan === '15') {
      const remaining = Math.max(0, Number(it?.boostPlan?.bumpsRemaining ?? 0) - 1);
      updates['boostPlan.bumpsRemaining'] = remaining;
      const interval = Math.floor((15 * DAY_MS) / 3); // ~5 days
      const next = remaining > 0 ? Math.min(now + interval, Number(it.featuredExpiry)) : null;
      updates['boostPlan.nextBumpAt'] = next;
    } else if (plan === '30') {
      const next = Math.min(now + HOUR_MS, Number(it.featuredExpiry));
      updates['boostPlan.nextBumpAt'] = next;
    } else {
      updates['boostPlan.nextBumpAt'] = null; // 3-day
    }

    batch.set(ref, updates, { merge: true });
    bumped++;
  }

  await batch.commit();
  return { statusCode: 200, body: JSON.stringify({ bumped }) };
};
