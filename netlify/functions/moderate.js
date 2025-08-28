// netlify/functions/moderate.js
const admin = require("firebase-admin");

/* ---------------- Firebase Admin init from FIREBASE_SERVICE_ACCOUNT_B64 ---------------- */
let inited = false;
function getAdmin() {
  if (inited) return admin;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_B64");

  const jsonStr = Buffer.from(b64, "base64").toString("utf8");
  const sa = JSON.parse(jsonStr);
  if (sa.private_key && sa.private_key.includes("\\n")) {
    sa.private_key = sa.private_key.replace(/\\n/g, "\n");
  }

  admin.initializeApp({ credential: admin.credential.cert(sa) });
  inited = true;
  return admin;
}
function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/* ---------------- Text utilities & patterns ---------------- */
const LEET_MAP = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s" };
const ILLEGAL_WORDS = [
  "gun","pistol","revolver","rifle","ak47","ak-47","grenade","tnt","dynamite","silencer",
  "cocaine","heroin","mdma","lsd","weed","ganja","charas","opium","meth","ketamine",
  "fake id","counterfeit","duplicate currency","proxy login","hacking service","carding",
  "escort","paid service","massage with happy ending",
  "ivory","animal skin","human organ"
];

const rePhoneTight   = /(?<!\d)(?:\+?91[\s-]*)?(?:[6-9]\d{9})(?!\d)/i;
const rePhoneSpaced  = /(?:\+?91[\s-]*)?(?:[6-9]\s*\d(?:\s*\d){8})/i;
const reEmail        = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const reUPI          = /\b[a-z0-9._-]{2,}@[a-z]{2,}\b/i;
const reURL          = /\b(?:https?:\/\/|www\.)\S+/i;
const reSocial       = /\b(?:wa\.me|whatsapp|telegram|t\.me|insta(?:gram)?|facebook\.com|fb\.com|snapchat|x\.com|twitter\.com)\b/i;
const rePromptDigits = /\b(?:call|whatsapp|contact|dm|message|inbox)\b.*\d(?:\D*\d){6,}/i;

const DIGIT_WORDS = { zero:0, one:1, two:2, three:3, for:4, four:4, five:5, six:6, seven:7, eight:8, ate:8, nine:9 };

function deLeet(s) {
  return String(s).replace(/[0134578@$]/g, ch => LEET_MAP[ch] || ch);
}
function normalizeAggressive(s = "") {
  return deLeet(String(s))
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\.\-_/\\|,:;(){}\[\]<>~^`'"“”‘’]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
function containsPhoneishWords(t) {
  const parts = String(t).split(/\s+/);
  let streak = 0;
  for (const p of parts) {
    if (/^\d$/.test(p) || Object.prototype.hasOwnProperty.call(DIGIT_WORDS, p)) {
      streak++; if (streak >= 7) return true;
    } else streak = 0;
  }
  return false;
}

function detectViolations({ title = "", html = "", price = "" }) {
  const joined = `${title} ${html}`;
  const norm = normalizeAggressive(joined);
  const issues = [];

  if (rePhoneTight.test(joined) || rePhoneSpaced.test(joined) || containsPhoneishWords(norm))
    issues.push("Phone numbers (even obfuscated) are not allowed.");
  if (reEmail.test(joined)) issues.push("Email addresses are not allowed.");
  if (reUPI.test(joined))   issues.push("UPI IDs are not allowed.");
  if (reURL.test(joined) || reSocial.test(norm) || rePromptDigits.test(norm))
    issues.push("External links, social handles or “contact me” with digits are not allowed.");

  for (const bad of ILLEGAL_WORDS) {
    const re = new RegExp(`\\b${bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(norm)) { issues.push(`Prohibited content detected: “${bad}”.`); break; }
  }

  if (price) {
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) issues.push("Enter a valid price.");
    else if (/^(?:9{4,}|1{4,}|7{4,}|0{4,})$/.test(String(Math.round(p)))) issues.push("Price looks unrealistic.");
  }
  return issues;
}

/* ---------------- Duplicate check (simhash) ---------------- */
function simhash64(text) {
  const tokens = normalizeAggressive(text).split(/\s+/).filter(Boolean);
  const v = new Array(64).fill(0);
  for (const tok of tokens) {
    let h = 1469598103934665603n; // FNV-1a 64
    for (let i = 0; i < tok.length; i++) {
      h ^= BigInt(tok.charCodeAt(i));
      h = (h * 1099511628211n) & ((1n << 64n) - 1n);
    }
    for (let b = 0; b < 64; b++) ((h >> BigInt(b)) & 1n) === 1n ? v[b]++ : v[b]--;
  }
  let out = 0n; for (let b = 0; b < 64; b++) if (v[b] > 0) out |= (1n << BigInt(b));
  return out;
}
function hamming64(a, b) { let x = a ^ b, c = 0; while (x) { x &= (x - 1n); c++; } return c; }

async function duplicateCheck(db, { category, city, itemId, text }) {
  const limit = Number(process.env.DUP_CHECK_LIMIT || 100);
  const q = db.collection("items")
    .where("category", "==", category || "")
    .where("city", "==", city || "")
    .orderBy("updatedAt", "desc")
    .limit(limit);

  const mine = simhash64(text);
  const snap = await q.get();

  let nearest = 64, flagged = false;
  snap.forEach(doc => {
    if (itemId && doc.id === itemId) return;
    const d = doc.data() || {};
    const otherText = `${d.title || ""} ${String(d.description || "")}`;
    const other = simhash64(otherText);
    const dist = hamming64(mine, other);
    if (dist < nearest) nearest = dist;
    if (dist <= 8) flagged = true; // very similar
  });
  return { flagged, nearest };
}

/* ---------------- Rate limit (per uid, 1 action / 5 min) ---------------- */
const RATE_MS = 5 * 60 * 1000;
async function rateGate(db, uid) {
  const ref = db.collection("users").doc(uid);
  const now = Date.now();
  const snap = await ref.get();
  const last = snap.exists ? Number(snap.data().lastActionAt || 0) : 0;
  if (now - last < RATE_MS) return { ok: false, waitMs: RATE_MS - (now - last) };
  await ref.set({ lastActionAt: now }, { merge: true });
  return { ok: true, waitMs: 0 };
}

/* ---------------- Netlify handler ---------------- */
exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, headers: { Allow: "POST" }, body: "Method Not Allowed" };
    }

    const admin = getAdmin();
    const db = admin.firestore();

    // Auth: Firebase ID token
    const authz = event.headers.authorization || event.headers.Authorization || "";
    const m = authz.match(/^Bearer\s+(.+)$/i);
    if (!m) return json(401, { ok: false, error: "Missing token" });

    const decoded = await admin.auth().verifyIdToken(m[1]);
    const uid = decoded.uid;

    const body = JSON.parse(event.body || "{}");
    const {
      title = "",
      html = "",
      price = "",
      category = "",
      city = "",
      itemId = null,
      mode = "live"
    } = body;

    // Rate-limit only on submit
    if (mode === "submit") {
      const gate = await rateGate(db, uid);
      if (!gate.ok) return json(429, { ok: false, error: "Rate limited", waitMs: gate.waitMs });
    }

    // Basic violations
    const issues = detectViolations({ title, html, price });

    // Duplicate check if basics passed and enough context present
    let duplicate = { flagged: false, nearest: 64 };
    if (issues.length === 0 && (title || html) && category && (city || city === "")) {
      const text = `${title} ${String(html).replace(/<[^>]*>/g, " ")}`;
      duplicate = await duplicateCheck(db, { category, city, itemId, text });
    }

    return json(200, { ok: true, issues, duplicate });
  } catch (e) {
    return json(500, { ok: false, error: String(e.message || e) });
  }
};
