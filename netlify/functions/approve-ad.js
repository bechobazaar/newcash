// netlify/functions/approve-ad.js
const admin = require("firebase-admin");
let appInited = false;

function initAdmin() {
  if (appInited) return;
  admin.initializeApp();
  appInited = true;
}

exports.handler = async (event) => {
  try {
    initAdmin();
    const db = admin.firestore();
    const { adId } = JSON.parse(event.body);

    const adRef = db.collection("items").doc(adId);
    const adSnap = await adRef.get();
    if (!adSnap.exists) return { statusCode: 404, body: "Not found" };

    const ad = adSnap.data();

    // freeze only stable fields
    const frozen = {
      budget: ad.budget ?? 0,
      bumpCount: ad.bumpCount ?? 0,
      timestamps: ad.timestamps ?? {},
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await adRef.collection("approvalSnapshots").doc("current").set(frozen, { merge: false });
    await adRef.set({ approval: { status: "approved", at: admin.firestore.FieldValue.serverTimestamp() } }, { merge: true });

    return { statusCode: 200, body: "Approved & snapshotted" };
  } catch (e) {
    return { statusCode: 500, body: "Error: " + e.message };
  }
};
