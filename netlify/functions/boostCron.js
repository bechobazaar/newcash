const { db, Timestamp, FieldValue } = require('./_firebaseAdmin');
const { resolvePlan, computeNextBump } = require('./_plans');

exports.handler = async () => {
  const now = Date.now();
  const nowTs = Timestamp.fromMillis(now);
  const maxDocs = 250; // per run

  try {
    // Pick items whose nextBumpAt is due
    const q = await db.collection('items')
      .where('status', '==', 'approved')
      .where('boost.active', '==', true)
      .where('boost.nextBumpAt', '<=', nowTs)
      .orderBy('boost.nextBumpAt', 'asc')
      .limit(maxDocs)
      .get();

    if (q.empty) return { statusCode: 200, body: 'No due bumps.' };

    const batches = [];
    let batch = db.batch();
    let ops = 0;

    for (const doc of q.docs) {
      const it = doc.data() || {};
      const b  = it.boost || {};
      const plan = resolvePlan(b.plan);
      const endMs = b.endAt?.toMillis ? b.endAt.toMillis() : 0;
      const lastMs= b.lastBumpedAt?.toMillis ? b.lastBumpedAt.toMillis() : 0;

      // expiry
      if (!plan || !endMs || endMs <= now) {
        batch.update(doc.ref, {
          'boost.active': false,
          'boost.nextBumpAt': null
        });
      } else {
        // bump now
        const pr = now + Math.floor(Math.random() * 500); // jitter to avoid ties
        const next = computeNextBump(plan, b.startAt?.toMillis?.() || now, now, endMs, b.bumpSchedule || []);

        batch.update(doc.ref, {
          priorityScore: pr,
          'boost.lastBumpedAt': Timestamp.fromMillis(now),
          'boost.nextBumpAt': next ? Timestamp.fromMillis(next) : null,
          // optional daily counter reset (simple)
          'boost.bumpsDoneToday': (plan.kind === 'DAILY1') ? 1 : FieldValue.delete()
        });
      }

      ops++;
      if (ops >= 450) {
        batches.push(batch.commit());
        batch = db.batch();
        ops = 0;
      }
    }

    batches.push(batch.commit());
    await Promise.all(batches);

    return { statusCode: 200, body: `Bumped ${q.size} items` };
  } catch (e) {
    console.error('boostCron error', e);
    return { statusCode: 500, body: 'Error' };
  }
};
