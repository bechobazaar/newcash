// netlify/functions/save-login-ip.js
const admin = require("firebase-admin");

let _inited = false;
function getAdmin() {
  if (_inited) return admin;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error("FIREBASE_SERVICE_ACCOUNT_B64 missing");
  const svc = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  if (svc.private_key) svc.private_key = svc.private_key.replace(/\\n/g, "\n");
  admin.initializeApp({ credential: admin.credential.cert(svc) });
  _inited = true;
  return admin;
}

function ipToKey(ip) {
  return (ip || "unknown").replace(/[^\w]/g, "_").toLowerCase().slice(0, 200);
}

exports.handler = async (event) => {
  // CORS
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "https://bechobazaar.com",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      },
      body: "",
    };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const adminSDK = getAdmin();
    const headers = event.headers || {};
    const rawFwd = headers["x-forwarded-for"] || headers["X-Forwarded-For"] || "";
    const nfIp =
      headers["x-nf-client-connection-ip"] ||
      headers["client-ip"] ||
      headers["x-real-ip"] ||
      (rawFwd ? rawFwd.split(",")[0].trim() : null) ||
      "unknown";

    const auth = headers.authorization || headers.Authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return { statusCode: 401, body: "Missing Bearer token" };

    const decoded = await adminSDK.auth().verifyIdToken(token, true);
    const uid = decoded.uid;

    const db = adminSDK.firestore();
    const ts = adminSDK.firestore.Timestamp.now();
    const ua = headers["user-agent"] || "unknown";
    const FieldValue = adminSDK.firestore.FieldValue;
    const ipKey = ipToKey(nfIp);

    await db.runTransaction(async (tx) => {
      // user latest + user login history
      const userRef = db.collection("users").doc(uid);
      const loginRef = userRef.collection("logins").doc();
      tx.set(loginRef, { ip: nfIp, at: ts, ua, forwardedFor: rawFwd || "" });
      tx.set(userRef, { lastIP: nfIp, lastLogin: ts, lastUA: ua }, { merge: true });

      // reverse index for IP
      const ipRef = db.collection("ip_users").doc(ipKey);
      tx.set(
        ipRef,
        {
          ip: nfIp,
          lastSeen: ts,
          uids: FieldValue.arrayUnion(uid), // unique
        },
        { merge: true }
      );

      // per-login hit (time-window analytics)
      const hitRef = ipRef.collection("hits").doc();
      tx.set(hitRef, { uid, at: ts, ua });
    });

    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "https://bechobazaar.com" },
      body: JSON.stringify({ ok: true, ip: nfIp }),
    };
  } catch (e) {
    console.error("save-login-ip error:", e);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
