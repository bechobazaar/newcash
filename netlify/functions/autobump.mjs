// ... init as you already have ...

// (B) reset only for DAILY plans
const liveSnap = await db.collection(BOOST_COLLECTION)
  .where('boost.active', '==', true)
  .get();

liveSnap.forEach(doc => {
  const b = doc.data()?.boost || {};
  if ((b.bumpsPerDay || 0) > 0) { // DAILY plans only
    const last = b?.lastBumpedAt?.toMillis?.() ?? 0;
    const istNow = new Date(now + 5.5 * 60 * 60 * 1000);
    const istYMD = istNow.toISOString().slice(0, 10);
    const istLast = new Date(last + 5.5 * 60 * 60 * 1000);
    const lastYMD = last ? istLast.toISOString().slice(0, 10) : null;
    if (lastYMD !== istYMD && (b.bumpsDoneToday ?? 0) !== 0) {
      resets++;
      batch.update(doc.ref, { 'boost.bumpsDoneToday': 0 });
    }
  }
});

// (C) process due bumps (both kinds)
const dueSnap = await db.collection(BOOST_COLLECTION)
  .where('boost.active', '==', true)
  .where('boost.nextBumpAt', '<=', nowTs)
  .get();

dueSnap.forEach(doc => {
  due++;
  const ref = doc.ref;
  const b = doc.data()?.boost || {};
  if (!b.active) return;

  // simple lock
  const lockUntil = b?.lockUntil?.toMillis?.() ?? 0;
  if (lockUntil > now) { skippedLocked++; return; }

  // WEEKLY-2 plan (49/15d)
  if (b.planType === 'W2_15D') {
    const doneTotal = b.bumpsDoneTotal || 0;
    const allowed   = b.totalBumpsAllowed || 2;
    if (doneTotal >= allowed || (b.endAt?.toMillis?.() ?? 0) <= now) {
      // finish scheduling
      batch.update(ref, { 'boost.nextBumpAt': null });
      return;
    }

    // bump now
    const updates = {
      priorityScore: now,
      'boost.lastBumpedAt': nowTs,
      'boost.bumpsDoneTotal': doneTotal + 1,
      'boost.lockUntil': admin.firestore.Timestamp.fromMillis(now + 60*1000)
    };

    // schedule next weekly bump if one left and still within endAt
    const nextTs = now + (b.weeklyIntervalMs || 7*24*60*60*1000);
    const endMs  = b.endAt?.toMillis?.() ?? 0;
    if (doneTotal + 1 < allowed && nextTs < endMs) {
      updates['boost.nextBumpAt'] = admin.firestore.Timestamp.fromMillis(nextTs);
    } else {
      updates['boost.nextBumpAt'] = null; // finished
    }

    bumped++;
    batch.update(ref, updates);
    return;
  }

  // DAILY plans (e.g., 99/30d)
  const perDay = b.bumpsPerDay || 0;
  if (perDay <= 0) { batch.update(ref, { 'boost.nextBumpAt': null }); return; }

  const doneDay = b.bumpsDoneToday || 0;
  if (doneDay >= perDay) {
    // next at IST midnight
    const ist = new Date(now + 5.5 * 60 * 60 * 1000);
    const nextMidnightIST = new Date(Date.UTC(
      ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1, 18, 30, 0
    ));
    batch.update(ref, { 'boost.nextBumpAt': admin.firestore.Timestamp.fromDate(nextMidnightIST) });
    return;
  }

  const updates = {
    priorityScore: now,
    'boost.lastBumpedAt': nowTs,
    'boost.bumpsDoneToday': doneDay + 1,
    'boost.lockUntil': admin.firestore.Timestamp.fromMillis(now + 60*1000)
  };

  if (perDay === 1) {
    const ist = new Date(now + 5.5 * 60 * 60 * 1000);
    const nextMidnightIST = new Date(Date.UTC(
      ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1, 18, 30, 0
    ));
    updates['boost.nextBumpAt'] = admin.firestore.Timestamp.fromDate(nextMidnightIST);
  } else if (perDay >= 2) {
    updates['boost.nextBumpAt'] = admin.firestore.Timestamp.fromMillis(now + 12*60*60*1000);
  }

  bumped++;
  batch.update(ref, updates);
});
