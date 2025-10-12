// netlify/functions/fanout-notification.js
import { getAdmin, corsHeaders, corsPreflight } from "./_admin.js";

const SITE_ORIGIN = "https://Bechobazaar.com";

// Build absolute site URL for server-side fetches
function getBaseUrl(event) {
  const envUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL;
  if (envUrl) return envUrl.replace(/\/+$/, "");
  const proto = (event.headers && (event.headers["x-forwarded-proto"] || event.headers["X-Forwarded-Proto"])) || "https";
  const host  = (event.headers && (event.headers.host || event.headers.Host)) || "";
  return `${proto}://${host}`;
}

// Always resolve path to absolute (default /account)
function toAbsUrl(pathOrUrl) {
  const open = (pathOrUrl || "/account") + ""; // ← default account
  return open.startsWith("http")
    ? open
    : (SITE_ORIGIN + (open.startsWith("/") ? open : ("/" + open)));
}

// Appilix-only push (for fallback)
async function appilixOnlyPush(event, { userId, title, body, imageUrl, open }) {
  if (!userId) throw new Error("userId required");
  const base = getBaseUrl(event);
  const url  = `${base}/.netlify/functions/send-appilix-push`;
  const openAbs = toAbsUrl(open || "/account"); // force /account

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify({
      user_identity: userId,
      title:  title || "Bechobazaar",
      message: body  || "You have a new notification",
      image_url: imageUrl || "",
      open_link_url: openAbs
    })
  });
  return { ok: res.ok, appilix: res.ok ? "sent" : "failed" };
}

export async function handler(event) {
  const pre = corsPreflight(event);
  if (pre) return pre;

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders(event.headers?.origin || "*"), body: "Method not allowed" };
  }

  try {
    const req = JSON.parse(event.body || "{}");

    // If no service account, fallback Appilix-only so UI not blocked
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
      const out = await appilixOnlyPush(event, {
        userId:  req.userId,
        title:   req.title,
        body:    req.body,
        imageUrl:req.imageUrl,
        open:    "/account" // enforce account
      });
      return {
        statusCode: out.ok ? 200 : 500,
        headers: corsHeaders(event.headers?.origin || "*"),
        body: JSON.stringify({ ok: !!out.ok, fcm: "skipped (no env)", ...out })
      };
    }

    // Initialize admin (base64 decode happens in _admin)
    const { admin, db } = getAdmin();

    // 1) Load/create notification
    const notifCol = db.collection("notifications");
    let notifId = req.notifId || null;
    let notif = null;

    if (notifId) {
      const snap = await notifCol.doc(notifId).get();
      if (!snap.exists) throw new Error("Notification doc not found");
      notif = { id: snap.id, ...snap.data() };
    } else {
      if (!req.userId) throw new Error("userId required");
      const doc = {
        userId:  req.userId,
        title:   req.title   || "Bechobazaar",
        body:    req.body    || "",
        imageUrl:req.imageUrl|| "",
        open:    "/account",         // ← enforce /account
        seen: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      };
      const ref = await notifCol.add(doc);
      notifId = ref.id;
      notif = { id: ref.id, ...doc };
    }

    // 2) Prepare payload
    const uid     = notif.userId;
    const title   = notif.title || "Bechobazaar";
    const text    = notif.body  || "You have a new notification";
    const image   = notif.imageUrl || "";
    const openAbs = toAbsUrl("/account"); // ← enforce /account

    // 3) Endpoints
    const userRef = db.collection("users").doc(uid);
    const [userSnap, fcmSnap] = await Promise.all([
      userRef.get(),
      userRef.collection("fcmTokens").get()
    ]);
    const fcmTokens  = fcmSnap.docs.map(d => (d.get("token") || "")).filter(Boolean);
    const appilixIds = userSnap.exists ? Object.keys(userSnap.get("appilixIds") || {}) : [];

    // 4) FCM (web)
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
            icon:  `${SITE_ORIGIN}/icons/icon-192.png`,
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

    // 5) Appilix (native)
    let appilix = { sent: 0, failed: 0 };
    if (appilixIds.length) {
      const base = getBaseUrl(event);
      const appilixUrl = `${base}/.netlify/functions/send-appilix-push`;
      const payload = {
        user_identity: uid,
        title,
        message: text,
        image_url: image || "",
        open_link_url: openAbs,
        data: { notifId }
      };
      const results = await Promise.allSettled(
        appilixIds.map(() =>
          fetch(appilixUrl, {
            method: "POST",
            headers: { "Content-Type":"application/json" },
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
      headers: corsHeaders(event.headers?.origin || "*"),
      body: JSON.stringify({ ok: true, notifId, fcm, appilix })
    };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin || "*"), body: JSON.stringify({ ok:false, error:String(e.message||e) }) };
  }
}
