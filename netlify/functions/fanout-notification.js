// netlify/functions/fanout-notification.js
import { getAdmin, corsHeaders, corsPreflight } from "./_admin.js";

const SITE_ORIGIN = "https://bechobazaar.com";

// Appilix proxy (aapka pehle se hai)
const APPILIX_PROXY = "/.netlify/functions/send-appilix-push";

export async function handler(event) {
  const pre = corsPreflight(event);
  if (pre) return pre;

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders(event.headers.origin || "*"), body: "Method not allowed" };
  }

  try {
    const { admin, db } = getAdmin();
    const req = JSON.parse(event.body || "{}");

    // 1) Notification doc load / create
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

    const uid = notif.userId;
    if (!uid) throw new Error("userId missing on notification");

    const title = notif.title || "BechoBazaar";
    const text  = notif.body  || "You have a new notification";
    const open  = (notif.open || "/notifications") + "";
    const openAbs = open.startsWith("http") ? open : (SITE_ORIGIN + (open.startsWith("/") ? open : ("/"+open)));
    const image = notif.imageUrl || "";

    // 2) Endpoints read
    const userRef = db.collection("users").doc(uid);
    const [userSnap, fcmSnap] = await Promise.all([
      userRef.get(),
      userRef.collection("fcmTokens").get()
    ]);

    const fcmTokens = fcmSnap.docs.map(d => (d.get("token") || "")).filter(Boolean);
    const appilixIds = userSnap.exists ? Object.keys(userSnap.get("appilixIds") || {}) : [];

    // 3) FCM push (web)
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
      const resp = await getAdmin().admin.messaging().sendEachForMulticast(msg);
      const toDelete = [];
      resp.responses.forEach((r, i) => {
        if (r.success) fcm.sent++;
        else {
          fcm.failed++;
          const code = r.error?.code || "";
          if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
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

    // 4) Appilix push (native app)
    let appilix = { sent: 0, failed: 0 };
    if (appilixIds.length) {
      const payload = {
        user_identity: uid, // aap uid ko hi identity use kar rahe ho
        title, message: text,
        image_url: image || "",
        open_link_url: openAbs,
        data: { notifId }
      };
      // Parallel: har identity pe ek call (proxy uid-identity pe map karta hai)
      const promises = appilixIds.map(() =>
        fetch(APPILIX_PROXY, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        })
      );
      const results = await Promise.allSettled(promises);
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
    return { statusCode: 500, headers: corsHeaders(event.headers.origin || "*"), body: JSON.stringify({ ok:false, error:String(e.message||e) }) };
  }
}
