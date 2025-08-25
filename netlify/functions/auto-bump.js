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

// --- helpers ---
function toMillis(v) {
  if (!v) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v) || 0;
  if (v.toMillis) return v.toMillis();
  if (v._seconds != null) return v._seconds * 1000 + Math.floor((v._nanoseconds || 0) / 1e6);
  return 0;
}
function mins(n) { return n * 60 * 1000; }

exports.handler = async () => {
  try {
    initAdmin();
    const db = admin.firestore();
    const nowMs = Date.now();

    // 🔍 Query only on boost.nextBumpAt to avoid composite index requirement
    const snap = await db.collection("items")
      .where("boost.nextBumpAt", "<=", nowMs)
      .limit(200)
      .get();

    console.log("[auto-bump] Fetched candidates:", snap.size);
    if (snap.empty) {
      return { statusCode: 200, body: "No due candidates." };
    }

    const batch = db.batch();
    let bumped = 0, notified = 0, skipped = 0;

    snap.docs.forEach((doc) => {
      const it = doc.data() || {};
      const b  = it.boost || {};

      const active = !!b.active;
      const endAt  = toMillis(b.endAt);
      const nextAt = toMillis(b.nextBumpAt);

      // code-side guards matching your data model
      if (!active) { skipped++; return; }
      if (endAt && endAt <= nowMs) { skipped++; return; }
      if (!nextAt || nextAt > nowMs) { skipped++; return; }

      // Optional caps (if you use them)
      const maxBumps = Number(b.maxBumps || 0);
      const currentBumps = Number(b.bumpCount || 0);
      if (maxBumps > 0 && currentBumps >= maxBumps) { skipped++; return; }

      // Frequency:
      // 1) boost.frequencyMins if provided
      // 2) else derive from bumpsPerDay (e.g., 1 -> 1440 mins)
      // 3) else default 180 mins
      let freqMins = Number(b.frequencyMins || 0);
      if (!freqMins) {
        const perDay = Number(b.bumpsPerDay || 0);
        if (perDay > 0) freqMins = Math.max(1, Math.floor(1440 / perDay));
      }
      if (!freqMins) freqMins = 180;

      const nextMs = nowMs + mins(freqMins);

      // ✅ Updates INSIDE boost (nested paths)
      batch.update(doc.ref, {
        "boost.lastBumpedAt": nowMs,
        "boost.nextBumpAt": nextMs,
        "boost.bumpCount": admin.firestore.FieldValue.increment(1),
        // helpful root field for sorting lists
        priorityScore: Math.floor(nowMs / 1000),
      });
      bumped++;

      // 🔔 Optional notification (if you store owner id)
      const ownerId = it.userId || it.ownerId || it.uid || it.sellerId || null;
      if (ownerId) {
        // best-effort image
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

    if (bumped === 0) {
      console.log(`[auto-bump] Nothing to bump. skipped=${skipped}`);
      return { statusCode: 200, body: `No bumps. Skipped ${skipped}.` };
    }

    await batch.commit();
    console.log(`[auto-bump] done. bumped=${bumped}, notified=${notified}, skipped=${skipped}`);
    return { statusCode: 200, body: `Bumped ${bumped}, notifications ${notified}, skipped ${skipped}` };

  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: "Auto-bump error: " + e.message };
  }
};
