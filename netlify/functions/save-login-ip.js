const admin = require("firebase-admin");

let initialized = false;
function getAdmin() {
  if (initialized) return admin;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error("FIREBASE_SERVICE_ACCOUNT_B64 missing");
  let svc;
  try {
    svc = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch (e) {
    throw new Error("Invalid FIREBASE_SERVICE_ACCOUNT_B64 (base64/JSON parse failed)");
  }
  if (svc.private_key) svc.private_key = svc.private_key.replace(/\\n/g, "\n");
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: svc.project_id,
      clientEmail: svc.client_email,
      privateKey: svc.private_key,
    }),
  });
  initialized = true;
  return admin;
}

exports.handler = async (event, context) => {
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
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  try {
    const adminSDK = getAdmin();
    const headers = event.headers || {};
    const rawFwd = headers["x-forwarded-for"] || headers["X-Forwarded-For"];
    const nfIp =
      headers["x-nf-client-connection-ip"] ||
      headers["client-ip"] ||
      headers["x-real-ip"] ||
      (rawFwd ? rawFwd.split(",")[0].trim() : null) ||
      "unknown";

    const auth = headers.authorization || headers.Authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return { statusCode: 401, body: "Missing Authorization Bearer token" };

    const decoded = await adminSDK.auth().verifyIdToken(token, true);
    const uid = decoded.uid;

    const db = adminSDK.firestore();
    const ts = adminSDK.firestore.Timestamp.now();
    const ua = headers["user-agent"] || "unknown";

    await db.runTransaction(async (tx) => {
      const recRef = db.collection("users").doc(uid).collection("logins").doc();
      const userRef = db.collection("users").doc(uid);
      tx.set(recRef, { ip: nfIp, at: ts, userAgent: ua, forwardedFor: rawFwd || "" });
      tx.set(userRef, { lastIP: nfIp, lastLogin: ts, lastUA: ua }, { merge: true });
    });

    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "https://bechobazaar.com" },
      body: JSON.stringify({ ok: true, ip: nfIp }),
    };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
