// netlify/functions/check-admin.js
const admin = require("firebase-admin");

let initialized = false;
function init() {
  if (initialized) return;
  const jsonString = Buffer.from(
    process.env.FIREBASE_SERVICE_ACCOUNT_B64,
    "base64"
  ).toString("utf8");
  const serviceAccount = JSON.parse(jsonString);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  initialized = true;
}

exports.handler = async (event) => {
  try {
    init();

    // token from client
    const auth = event.headers.authorization || "";
    const idToken = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!idToken) return { statusCode: 401, body: "Missing token" };

    const decoded = await admin.auth().verifyIdToken(idToken);
    const email = (decoded.email || "").toLowerCase();

    const allowed = (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    const isAllowed = allowed.includes(email) || decoded.admin === true;
    if (!isAllowed) return { statusCode: 403, body: "Forbidden" };

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, email }),
    };
  } catch (e) {
    return { statusCode: 500, body: "Error: " + e.message };
  }
};
