// netlify/functions/check-admin.js
// ❌ DO NOT use: firebase / firebase/app (client SDK)
// ✅ Use only: firebase-admin (server SDK)
const admin = require("firebase-admin");

let initialized = false;
function init() {
  if (initialized) return;

  // Get full service-account JSON from base64 env
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

// CORS: allow your ThePowerHost domain
const ALLOWED_ORIGIN = "https://bechobazaar.com";
function corsHeaders(origin) {
  const o = (origin || "").toLowerCase();
  const ok = o === ALLOWED_ORIGIN.toLowerCase() ? o : ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin": ok,
    "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

exports.handler = async (event) => {
  try {
    init();

    // Preflight
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: corsHeaders(event.headers.origin), body: "" };
    }

    const headers = corsHeaders(event.headers.origin);

    const auth = event.headers.authorization || "";
    const idToken = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!idToken) return { statusCode: 401, headers, body: "Missing token" };

    const decoded = await admin.auth().verifyIdToken(idToken);
    const email = (decoded.email || "").toLowerCase();

    const allowed = (process.env.ADMIN_EMAILS || "")
      .split(",").map(e => e.trim().toLowerCase()).filter(Boolean);

    const ok = allowed.includes(email) || decoded.admin === true;
    if (!ok) return { statusCode: 403, headers, body: "Forbidden" };

    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, email })
    };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders(event.headers?.origin), body: "Error: " + e.message };
  }
};
