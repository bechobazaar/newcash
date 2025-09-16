// netlify/functions/make-admin.js
const admin = require("firebase-admin");

let inited = false;
function getAdmin(){
  if (inited) return admin;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  const svc = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  if (svc.private_key) svc.private_key = svc.private_key.replace(/\\n/g, "\n");
  admin.initializeApp({ credential: admin.credential.cert(svc) });
  inited = true;
  return admin;
}

exports.handler = async () => {
  try {
    const adminSDK = getAdmin();

    // 🔴 yahan apne admin user ka exact UID daalo (Firebase Console → Authentication → Users me milta hai)
    const uid = "DIz6jbc2xrSZWpkqF5yF2maLcoy2";

    await adminSDK.auth().setCustomUserClaims(uid, { admin: true });
    return { statusCode: 200, body: JSON.stringify({ ok: true, uid }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
};
