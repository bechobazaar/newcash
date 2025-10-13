// netlify/functions/notify-ad-sold.js
import { getAdmin, corsHeaders, corsPreflight } from "./_admin.js";

const SITE = "https://bechobazaar.com";

export async function handler(event) {
  const pre = corsPreflight(event);
  if (pre) return pre;
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders(event.headers?.origin || "*"), body: "Method not allowed" };
  }

  try {
    const { admin, db } = getAdmin();
    const body = JSON.parse(event.body || "{}");
    const { itemId, sellerUid, title, imageUrl } = body;

    if (!itemId || !sellerUid) {
      return { statusCode: 400, headers: corsHeaders(event.headers?.origin || "*"), body: JSON.stringify({ ok:false, error:"itemId & sellerUid required" }) };
    }

    // 1) idempotency check
    const itemRef = db.collection("items").doc(itemId);
    const itemSnap = await itemRef.get();
    if (!itemSnap.exists) {
      return { statusCode: 404, headers: corsHeaders(event.headers?.origin || "*"), body: JSON.stringify({ ok:false, error:"item not found" }) };
    }
    const item = itemSnap.data() || {};
    if (item.soldNotified === true) {
      return { statusCode: 200, headers: corsHeaders(event.headers?.origin || "*"), body: JSON.stringify({ ok:true, info:"already notified" }) };
    }

    // 2) find recipients: everyone who chatted on this item, except seller
    const chatsSnap = await db.collection("chats").where("itemId", "==", itemId).get();
    const recipients = new Set();
    chatsSnap.forEach(doc => {
      const users = (doc.get("users") || []).filter(u => u && u !== sellerUid);
      users.forEach(u => recipients.add(u));
    });
    if (recipients.size === 0) {
      // still mark to avoid loops
      await itemRef.set({ soldNotified: true, soldNotifiedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return { statusCode: 200, headers: corsHeaders(event.headers?.origin || "*"), body: JSON.stringify({ ok:true, info:"no recipients" }) };
    }

    // 3) create notifications in batch
    const titleText = "✅ Ads Sold";
    const bodyText  = `The ad “${title || item.title || "Ad"}” is no longer available.`;
    const openPath  = "/account"; // where tap should go
    const batch = db.batch();
    const createdIds = [];

    for (const uid of recipients) {
      const ref = db.collection("notifications").doc();
      batch.set(ref, {
        userId: uid,
        title: titleText,
        body:  bodyText,
        imageUrl: imageUrl || item.thumbnailUrl || (Array.isArray(item.images) ? item.images[0] : "") || "",
        open: openPath,
        adId: itemId,
        type: "sold",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        seen: false
      });
      createdIds.push(ref.id);
    }
    // mark item
    batch.set(itemRef, { soldNotified: true, soldNotifiedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await batch.commit();

    // 4) server-side fanout push (call our existing fanout for each uid)
    const base = (process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || "").replace(/\/+$/,"");
    const fanoutUrl = (base ? base : SITE) + "/.netlify/functions/fanout-notification";

    const image = imageUrl || item.thumbnailUrl || (Array.isArray(item.images) ? item.images[0] : "") || "";
    const jobs = Array.from(recipients).map(uid => fetch(fanoutUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: uid,
        title:  titleText,
        body:   bodyText,
        imageUrl: image,
        open:   openPath
      })
    }));

    const results = await Promise.allSettled(jobs);
    const sent  = results.filter(r => r.status === "fulfilled" && r.value.ok).length;
    const fail  = results.length - sent;

    return {
      statusCode: 200,
      headers: corsHeaders(event.headers?.origin || "*"),
      body: JSON.stringify({ ok: true, recipients: recipients.size, sent, fail, notifCount: createdIds.length })
    };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin || "*"), body: JSON.stringify({ ok:false, error:String(e.message||e) }) };
  }
}
