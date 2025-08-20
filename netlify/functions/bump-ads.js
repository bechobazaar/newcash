/**
 * Netlify Scheduled Function: bump-ads
 * - Runs hourly
 * - Bumps eligible boosted ads by setting `bumpedAt` and scheduling `nextBump`
 * 
 * Requires GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT env with service account JSON.
 */
const admin = require("firebase-admin");

function initAdmin() {
  if (admin.apps.length) return;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  } else {
    admin.initializeApp(); // rely on GOOGLE_APPLICATION_CREDENTIALS
  }
}

exports.handler = async function () {
  try {
    initAdmin();
    const db = admin.firestore();
    const now = new Date();

    // Fetch active boosted ads
    const snap = await db.collection("ads")
      .where("boostEnd", ">", admin.firestore.Timestamp.fromDate(now))
      .get();

    let bumped = 0;
    const batch = db.batch();

    snap.forEach(doc => {
      const ad = doc.data();
      const adRef = doc.ref;

      // Guard
      if (!ad.boostPlan || !ad.boostStart) return;

      const start = ad.boostStart.toDate ? ad.boostStart.toDate() : new Date(ad.boostStart);
      const end   = ad.boostEnd?.toDate ? ad.boostEnd.toDate() : new Date(ad.boostEnd);
      const nextBump = ad.nextBump?.toDate ? ad.nextBump.toDate() : (ad.nextBump ? new Date(ad.nextBump) : null);

      if (end <= now) return; // expired

      // Only proceed when nextBump is due or missing
      if (nextBump && nextBump > now) return;

      let shouldBump = false;
      let newNextBump = null;

      if (ad.boostPlan === "49_15days") {
        // Strategy: 2 bumps total across the plan — at ~start and ~day 7 (or remaining mid-point)
        // Track how many bumps already done
        const bumpsDone = Number(ad.bumpsDone || 0);

        if (bumpsDone < 2) {
          shouldBump = true;
          const mid = new Date(start.getTime() + Math.min(7, Math.floor((end - start) / 86400000 / 2)) * 86400000);
          // After first bump, schedule the second bump ~midway; after second bump, push nextBump to end
          if (bumpsDone === 0) newNextBump = mid;
          else newNextBump = end;
        }
      } else if (ad.boostPlan === "99_30days") {
        // Hourly bumps while active
        shouldBump = true;
        newNextBump = new Date(now.getTime() + 60 * 60 * 1000);
      }

      if (shouldBump) {
        batch.update(adRef, {
          bumpedAt: admin.firestore.FieldValue.serverTimestamp(),
          nextBump: admin.firestore.Timestamp.fromDate(newNextBump),
          bumpsDone: admin.firestore.FieldValue.increment(1),
        });
        bumped++;
      }
    });

    if (bumped > 0) await batch.commit();
    return { statusCode: 200, body: JSON.stringify({ bumped }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: String(err) }) };
  }
};
