// netlify/functions/save-login-ip.js
const admin = require("firebase-admin");

/* ==== CORS helpers ==== */
const ORIGIN = "https://bechobazaar.com"; // <- your frontend origin (exact)
const CORS = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};
const ok  = (body, extraHeaders) => ({ statusCode: 200, headers: { ...CORS, ...(extraHeaders||{}) }, body: JSON.stringify(body) });
const err = (status, body)        => ({ statusCode: status, headers: CORS, body: JSON.stringify(body) });
const noc = ()                    => ({ statusCode: 204, headers: CORS, body: "" });

/* ==== Admin init ==== */
let _inited = false;
function getAdmin(){
  if (_inited) return admin;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error("FIREBASE_SERVICE_ACCOUNT_B64 missing");
  const svc = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  if (svc.private_key) svc.private_key = svc.private_key.replace(/\\n/g, "\n");
  admin.initializeApp({ credential: admin.credential.cert(svc) });
  _inited = true;
  return admin;
}

/* ==== utils ==== */
function ipToKey(ip){
  return (ip || "unknown").replace(/[^\w]/g, "_").toLowerCase().slice(0, 200);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return noc();
  if (event.httpMethod !== "POST")   return err(405, { error: "Method Not Allowed" });

  try {
    const adminSDK = getAdmin();
    const headers = event.headers || {};
    const rawFwd  = headers["x-forwarded-for"] || headers["X-Forwarded-For"] || "";
    const nfIp =
      headers["x-nf-client-connection-ip"] ||
      headers["client-ip"] ||
      headers["x-real-ip"] ||
      (rawFwd ? rawFwd.split(",")[0].trim() : null) ||
      "unknown";

    const auth  = headers.authorization || headers.Authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return err(401, { error: "Missing Bearer token" });

    const decoded = await adminSDK.auth().verifyIdToken(token, true);
    const uid     = decoded.uid;

    const db   = adminSDK.firestore();
    const ts   = adminSDK.firestore.Timestamp.now();
    const ua   = headers["user-agent"] || "unknown";
    const ipId = ipToKey(nfIp);

    await db.runTransaction(async (tx) => {
      // user latest + user login history
      const userRef  = db.collection("users").doc(uid);
      const loginRef = userRef.collection("logins").doc();
      tx.set(loginRef, { ip: nfIp, at: ts, ua, forwardedFor: rawFwd || "" });
      tx.set(userRef,  { lastIP: nfIp, lastLogin: ts, lastUA: ua }, { merge: true });

      // reverse index for IP
      const ipRef = db.collection("ip_users").doc(ipId);
      tx.set(ipRef, {
        ip: nfIp,
        lastSeen: ts,
        uids: adminSDK.firestore.FieldValue.arrayUnion(uid), // unique
      }, { merge: true });

      // per-login hit (time-window analytics)
      const hitRef = ipRef.collection("hits").doc();
      tx.set(hitRef, { uid, at: ts, ua });
    });

    return ok({ ok: true, ip: nfIp });
  } catch (e) {
    console.error("save-login-ip error:", e);
    return err(500, { ok: false, error: e.message });
  }
};
