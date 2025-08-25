// netlify/functions/auto-bump.js
const admin = require("firebase-admin");

let appInited = false;
function initAdmin() {
  if (appInited) return;

  const b64 =
    process.env.FIREBASE_SERVICE_ACCOUNT_B64 ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS_B64;

  let creds;
  if (b64) {
    const json = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    if (typeof json.private_key === "string") {
      json.private_key = json.private_key.replace(/\\n/g, "\n");
    }
    creds = {
      projectId: json.project_id,
      clientEmail: json.client_email,
      privateKey: json.private_key,
    };
  } else {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    let privateKey = process.env.FIREBASE_PRIVATE_KEY || "";
    const privateKeyB64 = process.env.FIREBASE_PRIVATE_KEY_B64;
    if (!privateKey && privateKeyB64) {
      privateKey = Buffer.from(privateKeyB64, "base64").toString("utf8");
    }
    if (!projectId || !clientEmail || !privateKey) {
      throw new Error("Missing Firebase credentials.");
    }
    creds = { projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, "\n") };
  }

  admin.initializeApp({ credential: admin.credential.cert(creds) });
  appInited = true;
}

exports.config = { schedule: "*/10 * * * *" }; // every 10 minutes (UTC)

// Normalize to millis (handles number or Firestore Timestamp)
function toMillis(v) {
  if (!v) return 0;
  if (typeof v === "number") return v;
  if (v.toMillis) return v.toMillis();
  if (v._seconds != null) return v._seconds * 1000 + Math.floor((v._nanoseconds || 0) / 1e6);
  return Number(v) || 0;
}

exports.handler = async () => {
  try {
    initAdmin();
    const db = admin.firestore();
    const nowMs = Date.now();

    // ✅ NESTED QUERY (matches your schema)
    const q = db
      .collection("items")
      .where("boost.active", "==", true)
      .where("boost.nextBumpAt", "<=", nowMs)
      .limit(200);

    const snap = await q.get();
    console.log("[auto-bump] due docs:", snap.size);

    if (snap.empty) {
      return { statusCode: 200, body: "No due boosts." };
    }

    const batch = db.batch();
    let bumped = 0;
    let notified = 0;

    snap.docs.forEach((doc) => {
      const it = doc.data() || {};
      const b = it.boost || {};

      // Window guard
      const endAtMs = toMillis(b.endAt);
      if (endAtMs && endAtMs <= nowMs) {
        console.log(`[auto-bump] skip expired`, doc.id);
        return;
      }

      const freqMins = Number(b.frequencyMins ?? 180);
      const nextMs = nowMs + freqMins * 60 * 1000;

      // ✅ Updates INSIDE boost (nested paths)
      batch.update(doc.ref, {
        "boost.lastBumpedAt": nowMs,
        "boost.nextBumpAt": nextMs,
        "boost.bumpCount": admin.firestore.FieldValue.increment(1),
        // Optional root field for sorting
        priorityScore: Math.floor(nowMs / 1000),
      });
      bumped++;

      // 🔔 Notification (optional)
      const ownerId = it.userId || it.ownerId || it.uid || it.sellerId || null;
      if (ownerId) {
        // pick an image
        let imageUrl = null;
        if (Array.isArray(it.images) && it.images.length) {
          const first = it.images[0];
          imageUrl = (typeof first === "string" && first) || first?.url || first?.src || null;
        }
        imageUrl = imageUrl || it.imageUrl || it.thumbnail || it.cover || null;

        const notifRef = db.collection("notifications").doc();
        batch.set(notifRef, {
          adId: doc.id,
          userId: ownerId,
          adminName: "AutoBump Service",
          imageUrl: imageUrl || null,
          message: `Your ad "${it.title || it.name || "Your ad"}" was auto-bumped.`,
          type: "autobump",
          seen: false,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          bump: { plan: String(b.plan || "") },
          targetUrl: `/item.html?id=${encodeURIComponent(doc.id)}`,
        });
        notified++;
      }
    });

    await batch.commit();
    console.log(`[auto-bump] done. bumped=${bumped}, notified=${notified}`);
    return { statusCode: 200, body: `Bumped ${bumped}, notifications ${notified}` };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: "Auto-bump error: " + e.message };
  }
};
