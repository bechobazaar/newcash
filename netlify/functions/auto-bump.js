// netlify/functions/auto-bump.js
const admin = require("firebase-admin");

let appInited = false;

function initAdmin() {
  if (appInited) return;

  // --- Option A: whole JSON in base64 ---
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64 || process.env.GOOGLE_APPLICATION_CREDENTIALS_B64;

  let creds;
  if (b64) {
    try {
      const json = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
      if (typeof json.private_key === "string") {
        json.private_key = json.private_key.replace(/\\n/g, "\n");
      }
      creds = {
        projectId: json.project_id,
        clientEmail: json.client_email,
        privateKey: json.private_key,
      };
    } catch (e) {
      throw new Error("Failed to parse FIREBASE_SERVICE_ACCOUNT_B64: " + e.message);
    }
  } else {
    // --- Option B: individual envs (with optional base64 private key) ---
    const projectId   = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

    let privateKey = process.env.FIREBASE_PRIVATE_KEY || "";
    const privateKeyB64 = process.env.FIREBASE_PRIVATE_KEY_B64;
    if (!privateKey && privateKeyB64) {
      privateKey = Buffer.from(privateKeyB64, "base64").toString("utf8");
    }

    if (!projectId || !clientEmail || !privateKey) {
      throw new Error(
        "Missing Firebase credentials. Set FIREBASE_SERVICE_ACCOUNT_B64 (preferred) " +
        "or FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + (FIREBASE_PRIVATE_KEY or FIREBASE_PRIVATE_KEY_B64)."
      );
    }

    privateKey = privateKey.replace(/\\n/g, "\n");
    creds = { projectId, clientEmail, privateKey };
  }

  admin.initializeApp({
    credential: admin.credential.cert(creds),
  });

  appInited = true;
}

exports.config = { schedule: "*/10 * * * *" }; // every 10 minutes (UTC)

exports.handler = async function () {
  try {
    initAdmin();
    const db  = admin.firestore();
    const now = admin.firestore.Timestamp.now();

    // Due boosts: active AND within window AND nextAt <= now
    const snap = await db.collection("items")
      .where("boost.active", "==", true)
      .where("boost.endAt", ">", now)
      .where("boost.nextAt", "<=", now)
      .limit(200)
      .get();

    if (snap.empty) {
      return { statusCode: 200, body: "No due boosts." };
    }

    const batch = db.batch();
    let bumped = 0;
    let notified = 0;

    snap.docs.forEach((doc) => {
      const it = doc.data() || {};
      const b  = it.boost || {};
      const freq = Number(b.frequencyMins || 180); // default 3h

      // Compute next schedule + bump counters
      const nowMs = Date.now();
      const nextAt = admin.firestore.Timestamp.fromMillis(nowMs + freq * 60 * 1000);
      const newPriority = Math.floor(nowMs / 1000);           // seconds epoch
      const bumpCount   = Number(b.bumpCount || 0) + 1;       // keep a running count

      // 1) Update item
      batch.update(doc.ref, {
        priorityScore: newPriority,
        "boost.bumpAt": now,                // when bumped (server time)
        "boost.nextAt": nextAt,             // next schedule
        "boost.bumpCount": bumpCount        // optional running counter
      });
      bumped++;

      // 2) Create notification for owner (if we can find owner id)
      const ownerId =
        it.userId || it.ownerId || it.uid || it.sellerId || null;

      if (ownerId) {
        // Try to pick a thumbnail
        let imageUrl = null;
        if (Array.isArray(it.images) && it.images.length) {
          const first = it.images[0];
          imageUrl =
            (typeof first === "string" && first) ||
            first?.url || first?.src || null;
        }
        imageUrl = imageUrl || it.imageUrl || it.thumbnail || it.cover || null;

        const title = it.title || it.name || "Your ad";
        const plan  = b.plan || b.planCode || b.name || "";

        const notifRef = db.collection("notifications").doc();
        batch.set(notifRef, {
          adId: doc.id,
          userId: ownerId,
          adminName: "AutoBump Service",
          imageUrl: imageUrl || null,
          message: `Your ad "${title}" was auto-bumped.`,
          type: "autobump",
          seen: false,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          bump: {
            plan: String(plan || ""),
            bumpNo: bumpCount
          },
          // Deep link to your item page (adjust if your route differs)
          targetUrl: `/item.html?id=${encodeURIComponent(doc.id)}`
        });
        notified++;
      }
    });

    await batch.commit();
    return { statusCode: 200, body: `Bumped ${bumped} ads, notifications ${notified}` };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: "Auto-bump error: " + e.message };
  }
};
