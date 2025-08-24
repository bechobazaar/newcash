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

    // Either plain key or base64 variant
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

    snap.docs.forEach((doc) => {
      const it = doc.data() || {};
      const b  = it.boost || {};
      const freq = Number(b.frequencyMins || 180); // default 3h

      const newPriority = Math.floor(Date.now() / 1000); // seconds epoch
      const nextAt = admin.firestore.Timestamp.fromMillis(Date.now() + freq * 60 * 1000);

      batch.update(doc.ref, {
        priorityScore: newPriority,
        "boost.bumpAt": now,
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
