// netlify/functions/get-suspicious-ips.js
const admin = require("firebase-admin");

let inited = false;
function getAdmin() {
  if (inited) return admin;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error("FIREBASE_SERVICE_ACCOUNT_B64 missing");
  const svc = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  if (svc.private_key) svc.private_key = svc.private_key.replace(/\\n/g, "\n");
  admin.initializeApp({ credential: admin.credential.cert(svc) });
  inited = true;
  return admin;
}

async function requireAdminFromToken(token) {
  const adminSDK = getAdmin();
  const decoded = await adminSDK.auth().verifyIdToken(token);
  if (!decoded || decoded.admin !== true) {
    const err = new Error("NOT_ADMIN");
    err.code = "NOT_ADMIN";
    throw err;
  }
  return decoded;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return { statusCode: 405, body: "Method Not Allowed" };

  try {
    const auth = event.headers.authorization || event.headers.Authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return { statusCode: 401, body: "Missing token" };

    await requireAdminFromToken(token);

    const adminSDK = getAdmin();
    const db = adminSDK.firestore();
    const snap = await db.collection("ip_users").orderBy("lastSeen", "desc").limit(200).get();

    const results = [];
    snap.forEach((doc) => {
      const d = doc.data() || {};
      const uids = Array.isArray(d.uids) ? d.uids : [];
      if (uids.length >= 2) {
        results.push({
          ipKey: doc.id,
          ip: d.ip || null,
          uids,
          lastSeen: d.lastSeen ? d.lastSeen.toDate() : null,
        });
      }
    });

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "https://bechobazaar.com",
      },
      body: JSON.stringify({ ok: true, results }),
    };
  } catch (e) {
    if (e.code === "NOT_ADMIN") return { statusCode: 403, body: "Forbidden" };
    console.error("get-suspicious-ips error:", e);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
