const admin = require("firebase-admin");

let inited = false;
function initAdmin() {
  if (inited) return;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64 || process.env.GOOGLE_APPLICATION_CREDENTIALS_B64;
  let creds;
  if (b64) {
    const json = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    if (typeof json.private_key === "string") json.private_key = json.private_key.replace(/\\n/g, "\n");
    creds = { projectId: json.project_id, clientEmail: json.client_email, privateKey: json.private_key };
  } else {
    const { FIREBASE_PROJECT_ID: projectId, FIREBASE_CLIENT_EMAIL: clientEmail } = process.env;
    let privateKey = process.env.FIREBASE_PRIVATE_KEY || "";
    if (!privateKey && process.env.FIREBASE_PRIVATE_KEY_B64)
      privateKey = Buffer.from(process.env.FIREBASE_PRIVATE_KEY_B64, "base64").toString("utf8");
    if (!projectId || !clientEmail || !privateKey) throw new Error("Missing Firebase admin creds");
    privateKey = privateKey.replace(/\\n/g, "\n");
    creds = { projectId, clientEmail, privateKey };
  }
  admin.initializeApp({ credential: admin.credential.cert(creds) });
  inited = true;
}

exports.config = { schedule: "*/10 * * * *" }; // every 10m

// --- helpers ---
const toNum = (v, d=0) => Number.isFinite(Number(v)) ? Number(v) : d;

// owner detection across common keys
function getOwnerId(it) {
  return (
    it.userId || it.uid || it.ownerId || it.sellerId ||
    it.postedBy || it.createdBy || it.user?.id || it.user?.uid || null
  );
}

function pickImageUrl(it) {
  if (Array.isArray(it.images) && it.images.length) {
    const f = it.images[0];
    if (typeof f === "string" && f) return f;
    if (f && typeof f === "object") return f.thumb || f.thumbnail || f.url || f.src || null;
  }
  return it?.approval?.thumb || it.imageUrl || it.thumbnail || it.cover || null;
}

exports.handler = async () => {
  try {
    initAdmin();
    const db = admin.firestore();
    const nowMs = Date.now();

    // Single-range query ⇒ index-free; endAt check memory में
    const snap = await db.collection("items")
      .where("boost.active", "==", true)
      .where("boost.nextBumpAt", "<=", nowMs)
      .limit(200) // safe: <= 400 writes/batch
      .get();

    if (snap.empty) return { statusCode: 200, body: "No due boosts." };

    const batch = db.batch();
    let bumped = 0, notified = 0, diag = 0;

    for (const d of snap.docs) {
      const it = d.data() || {};
      const b  = it.boost || {};

      // in-memory guard on endAt
      const endAt = toNum(b.endAt, 0);
      if (!(endAt > nowMs)) continue;

      // frequency
      const plan = String(b.plan || it.plan || "");
      let freqMins = toNum(b.frequencyMins, 0);
      if (!freqMins) {
        if (plan === "99") freqMins = 24 * 60;
        else if (plan === "49") freqMins = Math.round(3.5 * 24 * 60);
        else freqMins = 180;
      }

      const nextMs = Math.min(nowMs + freqMins * 60 * 1000, endAt);
      const newCount = toNum(b.bumpCount, 0) + 1;
      const priorityScore = Math.floor(nowMs / 1000);

      // bump updates (number-ms schema)
      batch.update(d.ref, {
        priorityScore,
        "boost.lastBumpedAt": nowMs,
        "boost.nextBumpAt": nextMs,
        "boost.bumpCount": newCount
      });
      bumped++;

      // --- notifications ---
      const ownerId = getOwnerId(it);
      const title   = it.title || it.name || "Your ad";
      const imageUrl= pickImageUrl(it);

      // if ownerId found → normal autobump notification
      if (ownerId) {
        const notifRef = db.collection("notifications").doc();
        batch.set(notifRef, {
          adId: d.id,
          userId: ownerId,
          adminName: "AutoBump Service",
          imageUrl: imageUrl || null,
          message: `Your ad "${title}" was auto-bumped.`,
          type: "autobump",
          seen: false,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          bump: { plan, bumpNo: newCount },
          targetUrl: `/detail.html?id=${encodeURIComponent(d.id)}&userId=${encodeURIComponent(ownerId)}`
        });
        notified++;
      } else {
        // Fallback diagnostic write so you SEE it in console
        const diagRef = db.collection("notifications").doc();
        batch.set(diagRef, {
          adId: d.id,
          userId: "__unknown__",               // so you can filter in console
          adminName: "AutoBump Service",
          imageUrl: imageUrl || null,
          message: `Auto-bumped (ownerId missing). Title: "${title}"`,
          type: "autobump-diag",
          seen: false,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          meta: { keys: Object.keys(it), plan, hint: "Add userId/uid/ownerId on item" }
        });
        diag++;
        console.warn(`[auto-bump] ownerId missing for item ${d.id}`);
      }
    }

    await batch.commit();
    return {
      statusCode: 200,
      body: `Bumped ${bumped}, notifications ${notified}, diag ${diag}`
    };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: "Auto-bump error: " + e.message };
  }
};
