const admin = require("firebase-admin");

let initialized = false;
function init() {
  if (initialized) return;
  const jsonString = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, "base64").toString("utf8");
  const serviceAccount = JSON.parse(jsonString);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  initialized = true;
}

// ✅ allowed origin: ThePowerHost domain (change to your real domain)
const ALLOWED_ORIGIN = "https://bechobazaar.com"; // e.g. your ThePowerHost domain

function corsHeaders(origin) {
  // allow only your site; not '*'
  const o = origin && origin.toLowerCase();
  const okOrigin = o === ALLOWED_ORIGIN.toLowerCase() ? o : ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin": okOrigin,
    "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

exports.handler = async (event) => {
  try {
    init();

    // 🟨 Handle preflight
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: corsHeaders(event.headers.origin), body: "" };
    }

    const headers = corsHeaders(event.headers.origin || "");

    // 🔐 Require Firebase ID token
    const auth = event.headers.authorization || "";
    const idToken = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!idToken) return { statusCode: 401, headers, body: "Missing token" };

    // Verify token
    const decoded = await admin.auth().verifyIdToken(idToken);
    const email = (decoded.email || "").toLowerCase();

    // Allowlist from env (no exposure to client)
    const allowed = (process.env.ADMIN_EMAILS || "")
      .split(",").map(e => e.trim().toLowerCase()).filter(Boolean);

    const isAllowed = allowed.includes(email) || decoded.admin === true;
    if (!isAllowed) return { statusCode: 403, headers, body: "Forbidden" };

    return {
      statusCode: 200,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, email })
    };
  } catch (e) {
    // include CORS even on error
    return { statusCode: 500, headers: corsHeaders("*"), body: "Error: " + e.message };
  }
};
