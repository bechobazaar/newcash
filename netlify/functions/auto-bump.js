// netlify/functions/auto-bump.js
const admin = require("firebase-admin");

/** ---------- Admin init ---------- */
let appInited = false;
function initAdmin() {
  if (appInited) return;

  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64 || process.env.GOOGLE_APPLICATION_CREDENTIALS_B64;
  let creds;

  if (b64) {
    const json = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    if (typeof json.private_key === "string") json.private_key = json.private_key.replace(/\\n/g, "\n");
    creds = { projectId: json.project_id, clientEmail: json.client_email, privateKey: json.private_key };
  } else {
    const projectId   = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    let privateKey    = process.env.FIREBASE_PRIVATE_KEY || "";
    const privateKeyB64 = process.env.FIREBASE_PRIVATE_KEY_B64;
    if (!privateKey && privateKeyB64) privateKey = Buffer.from(privateKeyB64, "base64").toString("utf8");
    if (!projectId || !clientEmail || !privateKey) {
      throw new Error("Missing Firebase credentials. Provide FIREBASE_SERVICE_ACCOUNT_B64 (preferred) or FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + (FIREBASE_PRIVATE_KEY or FIREBASE_PRIVATE_KEY_B64).");
    }
    privateKey = privateKey.replace(/\\n/g, "\n");
    creds = { projectId, clientEmail, privateKey };
  }

  admin.initializeApp({ credential: admin.credential.cert(creds) });
  appInited = true;
}

/** ---------- Helpers ---------- */

// robust owner id
function getOwnerId(it) {
  return it.userId || it.ownerId || it.uid || it.sellerId || null;
}

// robust thumbnail
function pickImageUrl(it) {
  // array(images) → string or object({thumb,thumbnail,url,src})
  if (Array.isArray(it.images) && it.images.length) {
    const first = it.images[0];
    if (typeof first === "string" && first) return first;
    if (first && typeof first === "object") {
      return first.thumb || first.thumbnail || first.url || first.src || null;
    }
  }
  // fallbacks
  return it.imageUrl || it.thumbnail || it.cover || null;
}

// safe number
function toNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** ---------- Netlify schedule (every 10 mins UTC) ---------- */
exports.config = { schedule: "*/10 * * * *" };

/** ---------- Handler ---------- */
exports.handler = async function () {
  try {
    initAdmin();
    const db = admin.firestore();

    const nowTs = admin.firestore.Timestamp.now();
    const nowMs = Date.now();

    // Items live under users/*/items → use collectionGroup
    // Support both data models:
    //   (A) boost.endAt/nextAt as Firestore Timestamp
    //   (B) boost.endAt/nextAt as Number(ms)
    const qTs = db.collectionGroup("items")
      .where("boost.active", "==", true)
      .where("boost.endAt", ">", nowTs)
      .where("boost.nextAt", "<=", nowTs)
      .limit(300);

    const qMs = db.collectionGroup("items")
      .where("boost.active", "==", true)
      .where("boost.endAt", ">", nowMs)
      .where("boost.nextAt", "<=", nowMs)
      .limit(300);

    const [sTs, sMs] = await Promise.all([qTs.get(), qMs.get()]);

    // merge without duplicates
    const seen = new Set();
    const dueDocs = [];
    for (const d of [...sTs.docs, ...sMs.docs]) {
      const key = d.ref.path;
      if (!seen.has(key)) {
        seen.add(key);
        dueDocs.push(d);
      }
    }

    if (!dueDocs.length) {
      return { statusCode: 200, body: "No due boosts." };
    }

    const batch = db.batch();
    let bumped = 0;
    let notified = 0;

    for (const doc of dueDocs) {
      const it = doc.data() || {};
      const b  = it.boost || {};

      // frequency (mins) — default 180 (3h) if missing
      const freqMins = toNum(b.frequencyMins, 180);

      // schedule next
      const nextMs = nowMs + freqMins * 60 * 1000;
      const nextTs = admin.firestore.Timestamp.fromMillis(nextMs);

      // bump counters & ordering
      const newPriority = Math.floor(nowMs / 1000);      // seconds epoch for sort
      const bumpCount   = toNum(b.bumpCount, 0) + 1;

      // write normalized fields
      batch.update(doc.ref, {
        priorityScore: newPriority,

        // mirrors for UI 6hr window helpers
        lastBumpedAt: nowTs,          // top-level mirror for client
        "boost.bumpAt": nowTs,        // TS
        "boost.bumpAtMs": nowMs,      // ms mirror

        "boost.nextAt": nextTs,       // TS
        "boost.nextAtMs": nextMs,     // ms mirror

        "boost.bumpCount": bumpCount
      });
      bumped++;

      // Notification for owner
      const ownerId = getOwnerId(it);
      if (ownerId) {
        const imageUrl = pickImageUrl(it);
        const title    = it.title || it.name || "Your ad";
        const plan     = b.plan || b.planCode || b.name || "";

        const notifRef = db.collection("notifications").doc();
        batch.set(notifRef, {
          adId: doc.id,
          userId: ownerId,
          adminName: "AutoBump Service",
          imageUrl: imageUrl || null,                     // ✅ thumbnail added
          message: `Your ad "${title}" was auto-bumped.`,
          type: "autobump",
          seen: false,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          bump: { plan: String(plan || ""), bumpNo: bumpCount },
          // deep link (adjust if your route differs)
          targetUrl: `/detail.html?id=${encodeURIComponent(doc.id)}&userId=${encodeURIComponent(ownerId)}`
        });
        notified++;
      }
    }

    await batch.commit();
    return { statusCode: 200, body: `Bumped ${bumped} ads, notifications ${notified}` };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: "Auto-bump error: " + e.message };
  }
};
