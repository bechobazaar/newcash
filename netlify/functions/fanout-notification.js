// netlify/functions/fanout-notification.js
import { getAdmin, corsHeaders, corsPreflight } from "./_admin.js";

const SITE_ORIGIN = "https://bechobazaar.com";
// Appilix proxy (already deployed)
const APPILIX_PROXY = "/.netlify/functions/send-appilix-push";

// --- helper: absolute URL from relative ---
function toAbsUrl(pathOrUrl) {
  const open = (pathOrUrl || "/notifications") + "";
  return open.startsWith("http")
    ? open
    : (SITE_ORIGIN + (open.startsWith("/") ? open : ("/" + open)));
}

// --- helper: Appilix-only push (no Firestore/FCM needed) ---
async function appilixOnlyPush({ userId, title, body, imageUrl, open }) {
  if (!userId) throw new Error("userId required for Appilix-only path");
  const openAbs = toAbsUrl(open);

  const res = await fetch(APPILIX_PROXY, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_identity: userId,
      title: title || "BechoBazaar",
      message: body  || "You have a new notification",
      image_url: imageUrl || "",
      open_link_url: openAbs
    })
  });

  const ok = res.ok;
  return { ok, appilix: ok ? "sent" : "failed" };
}

export async function handler(event) {
  const pre = corsPreflight(event);
  if (pre) return pre;

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders(event.headers.origin || "*"),
      body: "Method not allowed"
    };
  }

  try {
    const req = JSON.parse(event.body || "{}");

    // ===== FAST PATH: if FIREBASE_SERVICE_ACCOUNT is missing/invalid, do Appilix-only =====
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
      const out = await appilixOnlyPush({
        userId: req.userId,
        title: req.title,
        body:  req.body,
        imageUrl: req.imageUrl,
        open:  req.open
      });
      if (!out.ok) {
        return {
          statusCode: 500,
          headers: corsHeaders(event.headers.origin || "*"),
          body: JSON.stringify({ ok:false, error:"FIREBASE_SERVICE_ACCOUNT env missing; Appilix-only push failed" })
        };
      }
      return {
        statusCode: 200,
        headers: corsHeaders(event.headers.origin || "*"),
        body: JSON.stringify({ ok:true, fcm:"skipped (no env)", ...out })
      };
    }

    // ===== NORMAL PATH: decode base64 SA via _admin.js → Firestore + FCM + Appilix =====
    let admin, db;
    try {
      ({ admin, db } = getAdmin()); // _admin.js decodes BASE64 env & initializes firebase-admin
    } catch (e) {
      // If base64 invalid / JSON parse error: still fallback to Appilix-only
      const out = await appilixOnlyPush({
        userId: req.userId,
        title: req.title,
        body:  req.body,
        imageUrl: req.imageUrl,
        open:  req.open
      });
      return {
        statusCode: out.ok ? 200 : 500,
        headers: corsHeaders(event.headers.origin || "*"),
        body: JSON.stringify({
          ok: !!out.ok,
          fcm: "skipped (env invalid)",
          appilix: out.appilix,
          hint: "Check FIREBASE_SERVICE_ACCOUNT base64 value"
        })
      };
    }

    // --- load or create notification doc ---
    let notifId = req.notifId || null;
    let notif = null;

    if (notifId) {
      const snap = await db.collection("notifications").doc(notifId).get();
      if (!snap.exists) throw new Error("Notification doc not found");
      notif = { id: snap.id, ...snap.data() };
    } else {
      if (!req.userId) throw new Error("userId required");
      const doc = {
        userId: req.userId,
        title: req.title || "BechoBazaar",
        body:  req.body  || "",
        imageUrl: req.imageUrl || "",
        open:  req.open || "/notifications",
        seen: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };
      const ref = await db.collection("notifications").add(doc);
      notifId = ref.id;
      notif = { id: ref.id, ...doc };
    }

    const uid   = notif.userId;
    const title = notif.title || "BechoBazaar";
    const text  = notif.body  || "You have a new notification";
    const image = notif.imageUrl || "";
    const openAbs = toAbsUrl(notif.open);

    // --- read endpoints ---
    const userRef = db.collection("users").doc(uid);
    const [userSnap, fcmSnap] = await Promise.all([
      userRef.get(),
      userRef.collection("fcmTokens").get()
    ]);

    const fcmTokens  = fcmSnap.docs.map(d => (d.get("token") || "")).filter(Boolean);
    const appilixIds = userSnap.exists ? Object.keys(userSnap.get("appilixIds") || {}) : [];

    // --- FCM (web) ---
    let fcm = { sent: 0, failed: 0, pruned: 0 };
    if (fcmTokens.length) {
      const msg = {
        tokens: fcmTokens,
        notification: { title, body: text, image: image || undefined },
        data: { open: openAbs, notifId },
        webpush: {
          fcmOptions: { link: openAbs },
          headers: { Urgency: "high" },
          notification: {
            icon: `${SITE_ORIGIN}/icons/icon-192.png`,
            badge: `${SITE_ORIGIN}/icons/badge-72.png`
          }
        }
      };
      const resp = await (await getAdmin()).admin.messaging().sendEachForMulticast(msg);
      const toDelete = [];
      resp.responses.forEach((r, i) => {
        if (r.success) fcm.sent++;
        else {
          fcm.failed++;
          const code = r.error?.code || "";
          if (code === "messaging/registration-token-not-registered" ||
              code === "messaging/invalid-registration-token") {
            toDelete.push(fcmTokens[i]);
          }
        }
      });
      if (toDelete.length) {
        const batch = db.batch();
        toDelete.forEach(tok => batch.delete(userRef.collection("fcmTokens").doc(tok)));
        await batch.commit();
        fcm.pruned = toDelete.length;
      }
    }

    // --- Appilix (native) ---
    let appilix = { sent: 0, failed: 0 };
    if (appilixIds.length) {
      const payload = {
        user_identity: uid, // you’re using uid as identity
        title,
        message: text,
        image_url: image || "",
        open_link_url: openAbs,
        data: { notifId }
      };
      const results = await Promise.allSettled(
        appilixIds.map(() =>
          fetch(APPILIX_PROXY, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          })
        )
      );
      for (const r of results) {
        if (r.status === "fulfilled" && r.value.ok) appilix.sent++;
        else appilix.failed++;
      }
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers.origin || "*"),
      body: JSON.stringify({ ok: true, notifId, fcm, appilix })
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: corsHeaders(event.headers.origin || "*"),
      body: JSON.stringify({ ok:false, error:String(e.message||e) })
    };
  }
}
