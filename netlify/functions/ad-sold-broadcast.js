// netlify/functions/ad-sold-broadcast.js
// Broadcasts "Ad was sold" push to everyone who messaged the seller about this ad.

const fetch = require('node-fetch');
const admin = require('firebase-admin');

/* ---------- Firebase Admin Init (Base64 env) ---------- */
function decodeBase64(str) {
  try { return Buffer.from(str, "base64").toString("utf8"); }
  catch { return ""; }
}

function getAdminApp() {
  if (admin.apps.length) return admin.app();

  // Prefer single Base64-encoded service account JSON
  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (base64) {
    const json = JSON.parse(decodeBase64(base64));
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: json.project_id,
        clientEmail: json.client_email,
        privateKey: json.private_key.replace(/\\n/g, "\n")
      }),
      projectId: json.project_id
    });
    return admin.app();
  }

  // Fallback to individual Base64-encoded vars
  const projectId = decodeBase64(process.env.FIREBASE_PROJECT_ID || "").trim();
  const clientEmail = decodeBase64(process.env.FIREBASE_CLIENT_EMAIL || "").trim();
  let privateKey = decodeBase64(process.env.FIREBASE_PRIVATE_KEY || "");
  if (privateKey) privateKey = privateKey.replace(/\\n/g, "\n");

  if (projectId && clientEmail && privateKey) {
    admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
      projectId
    });
  } else {
    // fallback for local or emulator
    admin.initializeApp({});
  }

  return admin.app();
}

const db = getAdminApp().firestore();

/* ---------- CORS ---------- */
const ALLOWED_ORIGINS = [
  "https://bechobazaar.com",
  "https://www.bechobazaar.com",
  "https://bechobazaar.netlify.app",
  "http://localhost:8888",
  "http://localhost:5173"
];

function corsHeaders(origin) {
  const allowOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

/* ---------- Concurrency limiter ---------- */
function pLimit(limit = 10) {
  const q = []; let active = 0;
  const next = () => { active--; if (q.length) q.shift()(); };
  return fn => (...args) => new Promise((res, rej) => {
    const run = () => { active++; Promise.resolve(fn(...args)).then(res, rej).finally(next); };
    (active < limit) ? run() : q.push(run);
  });
}
const limit10 = pLimit(10);

/* ---------- Config ---------- */
const APPILIX_FN = process.env.APPILIX_FN_URL
  || 'https://bechobazaar.netlify.app/.netlify/functions/appilix-push';

/* ---------- Handler ---------- */
exports.handler = async (event) => {
  const origin = event.headers?.origin || "";
  const headers = corsHeaders(origin);

  try {
    // Preflight
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers, body: "" };
    }

    // Only POST
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, headers, body: "Method Not Allowed" };
    }

    const { adId, sellerId, adTitle, thumb, deepLink, message } =
      JSON.parse(event.body || "{}") || {};

    if (!adId || !sellerId) {
      return { statusCode: 400, headers, body: "adId and sellerId are required" };
    }

    // 🔍 Find all chat threads tied to this ad
    const chatsSnap = await db.collection("chats").where("itemId", "==", adId).get();
    const recipients = new Set();
    chatsSnap.forEach(doc => {
      const data = doc.data() || {};
      const users = Array.isArray(data.users) ? data.users : [];
      users.forEach(u => { if (u && u !== sellerId) recipients.add(u); });
    });

    if (recipients.size === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, sent: 0, reason: "no recipients" }) };
    }

    const title = adTitle ? `Sold: ${adTitle}` : "Ad was sold";
    const bodyText = message || "Thanks for your interest! This item has been sold.";
    const payload = {
      title,
      message: bodyText,
      body: bodyText,
      image_url: thumb || "",
      notification_image_url: thumb || "",
      open_link_url: deepLink || `https://bechobazaar.com/detail.html?id=${encodeURIComponent(adId)}`
    };

    // 🔔 Push to all buyers concurrently (limit 10)
    const jobs = [];
    for (const uid of recipients) {
      jobs.push(limit10(async () => {
        const r = await fetch(APPILIX_FN, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_identity: uid, ...payload })
        });
        const txt = await r.text();
        const ok = r.ok && !/\"status\"\s*:\s*\"false\"/i.test(txt);
        if (!ok) console.warn("Push failed for", uid, txt);
        return ok;
      }));
    }

    const results = await Promise.all(jobs.map(j => j()));
    const sent = results.filter(Boolean).length;

    // ✅ Optional: mark ad as broadcasted
    try {
      await db.collection("items").doc(adId).set(
        { soldBroadcastAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      );
    } catch (_) {}

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, total: recipients.size, sent }) };
  } catch (e) {
    console.error("Broadcast error:", e);
    return { statusCode: 500, headers, body: "Server error: " + (e && e.message) };
  }
};
