// functions/index.js
const functions = require("firebase-functions");
const admin = require("firebase-admin");

// Admin init (default creds on Firebase Functions)
if (!admin.apps.length) admin.initializeApp();

const db = admin.firestore();
const REGION = "asia-south1"; // India latency
const APP_BASE_URL = (process.env.APP_BASE_URL || "https://bechobazaar.com").replace(/\/$/, "");

/**
 * When a doc is created in top-level collection 'notifications',
 * automatically send a phone push to the target user.
 *
 * Expected doc shape (example):
 * {
 *   userId: "<uid>",                           // REQUIRED
 *   message: "Your ad “…” was rejected ...",   // REQUIRED (this is the push body)
 *   type: "rejected" | "approved" | "info",    // optional (sets title)
 *   adId: "...", adminName: "...", imageUrl: "...",
 *   timestamp: <server timestamp>, seen: false
 * }
 */
exports.notificationsOnCreate = functions
  .region(REGION)
  .firestore.document("notifications/{notifId}")
  .onCreate(async (snap, context) => {
    const notif = snap.data() || {};
    const notifId = context.params.notifId;

    const uid = String(notif.userId || "");
    const body = String(notif.message || "").trim();
    if (!uid || !body) {
      console.log("[notificationsOnCreate] missing uid/body, skip", { uid, notifId });
      return null;
    }

    // Title derivation by type (customize freely)
    const t = String(notif.type || "").toLowerCase();
    let title = "Notification";
    if (t === "approved") title = "Ad approved";
    else if (t === "rejected") title = "Ad rejected";
    else if (t === "warning") title = "Important update";
    else title = "New at Bechobazaar";

    // Deep link (customize: notifications page, ad page, etc.)
    let url = "/notifications.html";
    if (notif.adId) url = `/seller-uploads.html?ad=${encodeURIComponent(notif.adId)}`;
    const link = /^https?:\/\//.test(url) ? url : `${APP_BASE_URL}${url.startsWith("/") ? "" : "/"}${url}`;

    // Tag to collapse duplicates
    const tag = notif.adId ? `ad_${notif.adId}` : `notif_${notifId}`;

    // ===== Collect tokens (legacy + unified) & dedupe =====
    const tokens = new Set();

    // Old store: users/{uid}/fcmTokens/{tokenId}
    const legacy = await db.collection("users").doc(uid).collection("fcmTokens").get();
    legacy.forEach(d => d.id && tokens.add(d.id));

    // New store: users/{uid}/pushEndpoints/* -> { type: 'fcm_web' | 'native', token }
    try {
      const pe = await db.collection("users").doc(uid)
        .collection("pushEndpoints")
        .where("type", "in", ["fcm_web", "native"])
        .get();
      pe.forEach(d => {
        const x = d.data() || {};
        if (x.token) tokens.add(x.token);
      });
    } catch (e) {
      // Some emulators/older plans may not support 'in' queries; fallback:
      const peAll = await db.collection("users").doc(uid).collection("pushEndpoints").get();
      peAll.forEach(d => {
        const x = d.data() || {};
        if ((x.type === "fcm_web" || x.type === "native") && x.token) tokens.add(x.token);
      });
    }

    const tokenList = Array.from(tokens).filter(Boolean);
    if (!tokenList.length) {
      console.log("[notificationsOnCreate] No tokens for user", uid);
      // Mark pushed=false to help debugging (won't retrigger since onCreate)
      await snap.ref.set({ pushSent: false, pushReason: "no_tokens" }, { merge: true });
      return null;
    }

    // ===== DATA-ONLY FCM MESSAGE =====
    // Chrome auto-card duplication ko avoid karne ke liye 'notification' field NA bhejein
    const fcmMessage = {
      tokens: tokenList,
      data: {
        title: String(title),
        body: String(body),
        url: link,
        tag: String(tag),
        ch: "fcm",
        kind: "system",
        notifId: String(notifId)
      },
      webpush: {
        fcmOptions: { link },
        headers: { Urgency: "high", TTL: "600" } // 10m
      },
      android: { priority: "high" },
      apns: { headers: { "apns-priority": "10" } }
    };

    const res = await admin.messaging().sendEachForMulticast(fcmMessage);

    // ===== Cleanup invalid tokens (both stores) =====
    for (let i = 0; i < res.responses.length; i++) {
      const r = res.responses[i];
      if (!r.success) {
        const code = r.error?.code || "";
        if (code.includes("registration-token-not-registered") || code.includes("invalid-argument")) {
          const bad = tokenList[i];
          try {
            await db.collection("users").doc(uid).collection("fcmTokens").doc(bad).delete().catch(() => {});
            const qs = await db.collection("users").doc(uid).collection("pushEndpoints").where("token", "==", bad).get();
            qs.forEach(d => d.ref.delete().catch(() => {}));
          } catch (e) { /* ignore */ }
        }
      }
    }

    // Log & mark pushed (for observability / idempotency)
    await snap.ref.set({
      pushSent: true,
      pushStats: { sent: res.successCount, failed: res.failureCount },
      pushedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    console.log("[notificationsOnCreate] done", { uid, sent: res.successCount, failed: res.failureCount });
    return null;
  });
