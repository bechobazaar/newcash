import admin from 'firebase-admin';

let app;
function init(){
  if (!app) {
    app = admin.apps.length
      ? admin.app()
      : admin.initializeApp({
          credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
          })
        });
  }
  return app.firestore();
}

export async function handler() {
  const db = init();

  const now = Date.now();
  const nowTs = admin.firestore.Timestamp.fromMillis(now);

  // 1) expire ho chuke boosts band karo
  const expSnap = await db.collection('ads')
    .where('boost.active','==', true)
    .where('boost.endAt','<=', nowTs)
    .get();

  const batch = db.batch();
  expSnap.forEach(doc => {
    batch.update(doc.ref, { 'boost.active': false, 'boost.nextBumpAt': null });
  });

  // IST midnight reset helper
  const istNow = new Date(now + 5.5*60*60*1000);
  const istYMD = istNow.toISOString().slice(0,10);

  // 2) live boosts fetch
  const liveSnap = await db.collection('ads')
    .where('boost.active','==', true)
    .get();

  liveSnap.forEach(doc => {
    const d = doc.data(); const b = d.boost || {};
    const last = b?.lastBumpedAt?.toMillis?.() ?? 0;
    const istLast = new Date(last + 5.5*60*60*1000);
    const lastYMD = last ? istLast.toISOString().slice(0,10) : null;
    if (lastYMD !== istYMD && (b.bumpsDoneToday ?? 0) !== 0) {
      batch.update(doc.ref, { 'boost.bumpsDoneToday': 0 });
    }
  });

  // 3) due bumps
  const dueSnap = await db.collection('ads')
    .where('boost.active','==', true)
    .where('boost.nextBumpAt','<=', nowTs)
    .get();

  dueSnap.forEach(doc => {
    const d = doc.data(); const b = d.boost || {};
    if (!b.active) return;
    const perDay = b.bumpsPerDay || 0;
    if (perDay === 0) { // ₹29 plan
      batch.update(doc.ref, { 'boost.nextBumpAt': null });
      return;
    }
    const done = b.bumpsDoneToday || 0;
    if (done >= perDay) {
      // next = IST midnight
      const ist = new Date(now + 5.5*60*60*1000);
      const nextMidnightIST = new Date(Date.UTC(
        ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()+1, 18, 30, 0
      ));
      batch.update(doc.ref, { 'boost.nextBumpAt': admin.firestore.Timestamp.fromDate(nextMidnightIST) });
      return;
    }

    // BUMP NOW
    const updates = {
      priorityScore: Date.now(),
      'boost.lastBumpedAt': nowTs,
      'boost.bumpsDoneToday': done + 1
    };

    // next bump time
    if (perDay === 1) {
      // kal IST midnight
      const ist = new Date(now + 5.5*60*60*1000);
      const nextMidnightIST = new Date(Date.UTC(
        ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()+1, 18, 30, 0
      ));
      updates['boost.nextBumpAt'] = admin.firestore.Timestamp.fromDate(nextMidnightIST);
    } else if (perDay === 2) {
      updates['boost.nextBumpAt'] = admin.firestore.Timestamp.fromMillis(now + 12*60*60*1000);
    }

    batch.update(doc.ref, updates);
  });

  await batch.commit();
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
}
