// netlify/functions/admin-auth.js
const crypto = require("crypto");

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}
// constant-time compare
function safeEq(a, b) {
  const A = Buffer.from(a || "", "utf8");
  const B = Buffer.from(b || "", "utf8");
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

exports.handler = async (event) => {
  // CORS (allow your domain)
  const headers = {
    "Access-Control-Allow-Origin": "*", // ← lock to your domain in prod
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: "Method Not Allowed" }) };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { password, purpose } = body;

    if (!password || !purpose) {
      return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Missing fields" }) };
    }

    // allow-list purposes (optional hardening)
    const ALLOWED = new Set(["amount-received", "category-manager"]);
    if (!ALLOWED.has(purpose)) {
      return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: "Invalid purpose" }) };
    }

    // two ways to configure secret:
    // 1) Plain password (simplest): ADMIN_PASSWORD (no CLI needed)
    // 2) SHA-256 hex: ADMIN_PASS_HASH
    const PLAIN = process.env.ADMIN_PASSWORD || "";
    const HASH  = process.env.ADMIN_PASS_HASH || "";

    let ok = false;
    if (PLAIN) {
      ok = safeEq(password, PLAIN);
    } else if (HASH) {
      ok = safeEq(sha256Hex(password), HASH.toLowerCase());
    } else {
      // misconfigured function
      return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: "Server not configured" }) };
    }

    if (!ok) {
      return { statusCode: 401, headers, body: JSON.stringify({ ok: false, error: "Invalid password" }) };
    }

    // success: you can also mint a short token if you want (skipped here)
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        // echo minimal info
        purpose,
        ts: Date.now(),
      }),
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: "Server error" }) };
  }
};
