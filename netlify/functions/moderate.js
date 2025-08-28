// netlify/functions/moderate.js
const admin = require("firebase-admin");

/* ====== CORS helpers ====== */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",                   // same-site pe bhi safe
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json"
};
const j = (status, body) => ({ statusCode: status, headers: CORS_HEADERS, body: JSON.stringify(body) });

/* ====== Firebase Admin init (FIREBASE_SERVICE_ACCOUNT_B64) ====== */
let inited = false;
function getAdmin() {
  if (inited) return admin;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_B64");
  const sa = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  if (sa.private_key && sa.private_key.includes("\\n")) sa.private_key = sa.private_key.replace(/\\n/g, "\n");
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  inited = true;
  return admin;
}

/* ====== (rest of your detection code – unchanged) ======
   - detectViolations(...)
   - duplicateCheck(...)
   - rateGate(...)
   (Use the same implementations you already have.)
*/

exports.handler = async (event) => {
  try {
    // 1) CORS preflight
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: CORS_HEADERS, body: "" };
    }

    // 2) Only POST allowed
    if (event.httpMethod !== "POST") {
      return j(405, { ok: false, error: "Use POST /.netlify/functions/moderate" });
    }

    const admin = getAdmin();
    const db = admin.firestore();

    // 3) Auth
    const authz = event.headers.authorization || event.headers.Authorization || "";
    const m = authz.match(/^Bearer\s+(.+)$/i);
    if (!m) return j(401, { ok: false, error: "Missing token" });

    let decoded;
    try { decoded = await admin.auth().verifyIdToken(m[1]); }
    catch { return j(401, { ok: false, error: "Invalid Firebase token" }); }
    const uid = decoded.uid;

    // 4) Body parse
    let body = {};
    try { body = JSON.parse(event.body || "{}"); }
    catch { return j(400, { ok: false, error: "Invalid JSON body" }); }

    const { title="", html="", price="", category="", city="", itemId=null, mode="live" } = body;

    // 5) Rate-limit only on submit
    if (mode === "submit") {
      const gate = await rateGate(db, uid);                 // <-- your existing function
      if (!gate.ok) return j(429, { ok:false, error:"Rate limited", waitMs: gate.waitMs });
    }

    // 6) Violations
    const issues = detectViolations({ title, html, price }); // <-- your existing function

    // 7) Duplicate (safe-try to avoid 500 on index issues)
    let duplicate = { flagged:false, nearest:64 };
    try {
      if (!issues.length && (title || html) && category) {
        const text = `${title} ${String(html).replace(/<[^>]*>/g, " ")}`;
        duplicate = await duplicateCheck(db, { category, city, itemId, text }); // <-- your existing function
      }
    } catch (e) {
      console.error("duplicateCheck:", e.message);
    }

    return j(200, { ok:true, issues, duplicate });
  } catch (e) {
    console.error("moderate error:", e);
    return j(500, { ok:false, error: String(e.message || e) });
  }
};
