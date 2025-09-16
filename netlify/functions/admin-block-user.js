// netlify/functions/admin-block-user.js
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
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };
  try {
    const auth = event.headers.authorization || event.headers.Authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return { statusCode: 401, body: "Missing token" };
    await requireAdminFromToken(token);

    const body = JSON.parse(event.body || "{}");
    const uid = body.uid;
    const action = (body.action || "disable").toLowerCase();
    if (!uid) return { statusCode: 400, body: "uid required" };

    const adminSDK = getAdmin();
    if (action === "disable") {
      await adminSDK.auth().updateUser(uid, { disabled: true });
      await adminSDK.firestore().collection("users").doc(uid).set(
        { suspended: true, suspendedAt: adminSDK.firestore.Timestamp.now(), suspendedBy: "admin" },
        { merge: true }
      );
    } else if (action === "enable") {
      await adminSDK.auth().updateUser(uid, { disabled: false });
      await adminSDK.firestore().collection("users").doc(uid).set(
        { suspended: false, suspendedAt: null, suspendedBy: null },
        { merge: true }
      );
    } else {
      return { statusCode: 400, body: "unknown action" };
    }

    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "https://bechobazaar.com" },
      body: JSON.stringify({ ok: true }),
    };
  } catch (e) {
    if (e.code === "NOT_ADMIN") return { statusCode: 403, body: "Forbidden" };
    console.error("admin-block-user error:", e);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
