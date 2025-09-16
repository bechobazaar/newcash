// netlify/functions/get-ip-details.js
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

    const ipKey = (event.queryStringParameters && event.queryStringParameters.ipKey) || "";
    if (!ipKey) return { statusCode: 400, body: "ipKey required" };

    const adminSDK = getAdmin();
    const db = adminSDK.firestore();
    const ipRef = db.collection("ip_users").doc(ipKey);
    const doc = await ipRef.get();
    if (!doc.exists) {
      return { statusCode: 404, body: "Not Found" };
    }

    const d = doc.data() || {};
    const uids = Array.isArray(d.uids) ? d.uids : [];
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const hitsSnap = await ipRef
      .collection("hits")
      .where("at", ">=", adminSDK.firestore.Timestamp.fromDate(since))
      .orderBy("at", "desc")
      .limit(200)
      .get();

    const hits = hitsSnap.docs.map((h) => {
      const hd = h.data();
      return {
        uid: hd.uid,
        at: hd.at && hd.at.toDate ? hd.at.toDate() : null,
        ua: hd.ua || null,
      };
    });

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "https://bechobazaar.com",
      },
      body: JSON.stringify({ ok: true, ipKey, ip: d.ip || null, uids, hits }),
    };
  } catch (e) {
    if (e.code === "NOT_ADMIN") return { statusCode: 403, body: "Forbidden" };
    console.error("get-ip-details error:", e);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
