// netlify/functions/auto-bump.js
const admin = require("firebase-admin");

let appInited = false;
function initAdmin() {
  if (appInited) return;
  const {
    FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY
  } = process.env;

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: FIREBASE_PROJECT_ID,
      clientEmail: FIREBASE_CLIENT_EMAIL,
      privateKey: FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
    }),
  });

  appInited = true;
}

exports.handler = async function () {
  try {
    initAdmin();
    const db = admin.firestore();
    const now = admin.firestore.Timestamp.now();

    // Due boosts: active AND within window AND nextAt <= now
    const snap = await db.collection("items")
      .where("boost.active", "==", true)
      .where("boost.endAt", ">", now)
      .where("boost.nextAt", "<=", now)
      .limit(200) // safety
      .get();

    if (snap.empty) {
      return { statusCode: 200, body: "No due boosts." };
    }

    const batch = db.batch();

    snap.docs.forEach((doc) => {
      const it = doc.data() || {};
      const b  = it.boost || {};
      const freq = Number(b.frequencyMins || 180); // default 3h
      const last = now; // we are bumping now

      // Priority strategy:
      //   - Tumhari sort me priorityScore pehle aata hai,
      //     isliye ise time-based large number set kar do.
      const newPriority = Math.floor(Date.now() / 1000); // seconds epoch

      // nextAt = now + frequency
      const nextAt = admin.firestore.Timestamp.fromMillis(
        Date.now() + freq * 60 * 1000
      );

      batch.update(doc.ref, {
        priorityScore: newPriority,
        "boost.bumpAt": last,
        "boost.nextAt": nextAt,
      });
    });

    await batch.commit();
    return { statusCode: 200, body: `Bumped ${snap.size} ads` };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: "Auto-bump error: " + e.message };
  }
};
