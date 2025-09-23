// netlify/functions/save-login-ip.js
const admin = require("firebase-admin");

/* ===== CORS (allow prod, preview, local) ===== */
const ALLOWED = new Set([
  "https://bechobazaar.com",
  "https://www.bechobazaar.com",
  "https://bechobazaar.netlify.app",
  "http://localhost:8888",
  "http://127.0.0.1:5500"
]);
function cors(event) {
  const h = event.headers || {};
  const origin = h.origin || h.Origin || "";
  const allow = ALLOWED.has(origin) ? origin : "https://bechobazaar.com";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Vary": "Origin"
  };
}
const ok  = (b,h)=>({ statusCode:200, headers:h, body:JSON.stringify(b) });
const err = (s,b,h)=>({ statusCode:s, headers:h, body:JSON.stringify(b) });
const noc = (h)=>({ statusCode:204, headers:h, body:"" });

/* ===== Admin init (supports multiple env var names) ===== */
let inited = false;
function getAdmin() {
  if (inited) return admin;
  const b64 =
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ||
    process.env.FIREBASE_SERVICE_ACCOUNT_B64 ||
    process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!b64) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_BASE64/B64 env var");
  let svc;
  try { svc = JSON.parse(Buffer.from(b64, "base64").toString("utf8")); }
  catch { svc = JSON.parse(b64); }
  if (svc.private_key) svc.private_key = svc.private_key.replace(/\\n/g, "\n");
  admin.initializeApp({ credential: admin.credential.cert(svc) });
  inited = true;
  return admin;
}

/* ===== IP helpers ===== */
const ipKey = ip => (ip || "unknown").replace(/[^\w]/g, "_").toLowerCase().slice(0, 200);
function extractClientIP(h = {}) {
  const xf = h["x-forwarded-for"] || h["X-Forwarded-For"] || "";
  const nf = h["x-nf-client-connection-ip"] || h["X-NF-Client-Connection-IP"] || "";
  const xr = h["x-real-ip"] || h["X-Real-Ip"] || "";
  const cand = []
    .concat(xf ? xf.split(",") : [])
    .concat(nf ? [nf] : [])
    .concat(xr ? [xr] : [])
    .map(s => String(s || "").trim())
    .filter(Boolean);

  // Prefer plain IPv4
  for (const ip of cand) if (ip.includes(".")) return ip;
  // Handle ::ffff:1.2.3.4
  for (const ip of cand) {
    const m = ip.match(/::ffff:([\d.]+)/i);
    if (m) return m[1];
  }
  return cand[0] || "unknown";
}

/* ===== Handler ===== */
exports.handler = async (event) => {
  const CORS = cors(event);
  if (event.httpMethod === "OPTIONS") return noc(CORS);
  if (event.httpMethod !== "POST")    return err(405, { error: "Method Not Allowed" }, CORS);

  try {
    const adminSDK = getAdmin();
    const h = event.headers || {};

    // ---- Auth (Firebase ID token) ----
    const authz = h.authorization || h.Authorization || "";
    const token = authz.startsWith("Bearer ") ? authz.slice(7) : null;
    if (!token) return err(401, { error: "Missing Bearer token" }, CORS);

    const decoded = await adminSDK.auth().verifyIdToken(token, true);
    const uid = decoded.uid;

    // ---- Data ----
    const ip  = extractClientIP(h);
    const ua  = h["user-agent"] || h["User-Agent"] || "unknown";
    const raw = h["x-forwarded-for"] || h["X-Forwarded-For"] || "";

    const db = adminSDK.firestore();
    const ts = adminSDK.firestore.FieldValue.serverTimestamp();

    // ✅ All writes tied to users/{uid}; never .add() on root "users"
    await db.runTransaction(async (tx) => {
      const uRef  = db.collection("users").doc(uid);
      const lgRef = uRef.collection("logins").doc();
      tx.set(uRef,  { lastIP: ip, lastLogin: ts, lastUA: ua }, { merge: true });
      tx.set(lgRef, { ip, at: ts, ua, forwardedFor: raw });

      const ipRef = db.collection("ip_users").doc(ipKey(ip));
      tx.set(ipRef, {
        ip,
        lastSeen: ts,
        uids: adminSDK.firestore.FieldValue.arrayUnion(uid)
      }, { merge: true });
      tx.set(ipRef.collection("hits").doc(), { uid, at: ts, ua });
    });

    return ok({ ok: true, ip }, CORS);
  } catch (e) {
    console.error("save-login-ip", e);
    return err(500, { ok: false, error: String(e.message || e) }, CORS);
  }
};
