// netlify/functions/price-advice.js
// Node 18+ (Netlify): global fetch present. No extra deps needed.

// ─── CONFIG ─────────────────────────────────────────────────────────────
const MODEL_ORDER = ["gemini-2.5-flash", "gemini-1.5-pro"];  // override by x-gemini-model
// PROD me '*' mat rakho. Neeche client origin fill karo:
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*"; // e.g. "https://bechobazaar.com"

// NOTE: Hardcoded key avoid karo; sirf emergency/dev ke liye:
// set env: GEMINI_API_KEY in Netlify UI
const GEMINI_KEY_FALLBACK = "AIzaSyD6Uvvth0RMC-I44K3vcan13JcSKPyIZrw"; // keep empty in prod

// ─── small utils ────────────────────────────────────────────────────────
const ok = (body, headers = {}) => ({
  statusCode: 200,
  headers: {
    "content-type": "application/json",
    "access-control-allow-origin": CORS_ORIGIN,
    "access-control-allow-headers": "content-type,x-gemini-key,x-gemini-model",
    "access-control-allow-methods": "POST,OPTIONS",
    ...headers
  },
  body: typeof body === "string" ? body : JSON.stringify(body)
});
const err = (code, msg, extra = {}) => ok({ error: msg, code, ...extra });

const clampInt = (n) => {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? v : undefined;
};

const sanitizeBands = (bands = {}) => {
  const out = {};
  for (const k of ["quick","suggested","patient","median","p25","p75"]) {
    const v = clampInt(bands[k]);
    if (typeof v === "number") out[k] = v;
  }
  return out;
};

const forceJSON = (t) => {
  if (!t) return null;
  try { return JSON.parse(t); } catch {}
  const m = t.match(/```json\s*([\s\S]*?)```/i) || t.match(/```\s*([\s\S]*?)```/);
  if (m?.[1]) { try { return JSON.parse(m[1]); } catch {} }
  const i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i !== -1 && j !== -1 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch {} }
  return null;
};

const bandsFromAnchor = (p) => {
  const n = Number(p || 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  return {
    quick: Math.round(n * 0.92),
    suggested: Math.round(n),
    patient: Math.round(n * 1.08),
    median: Math.round(n),
    p25: Math.round(n * 0.95),
    p75: Math.round(n * 1.05)
  };
};

const mkHeuristic = (item) => {
  const place = [item?.area, item?.city, item?.state].filter(Boolean).join(", ");
  return {
    summary: "Heuristic preview (AI unavailable).",
    priceBands: bandsFromAnchor(item?.price) || {},
    marketNotes: "Limited comps; conservative ±8% band.",
    localReality: place ? `Local demand considered for ${place}.` : "Locality unknown.",
    factors: [
      "Condition / age / battery health impacts ±5–12%",
      "Original bill/box/warranty improves trust",
      "Clear photos + honest defects convert faster"
    ],
    listingCopy: {
      title: `${item?.brand || ""} ${item?.model || ""} — ${place}`.trim(),
      descriptionShort: "Clean condition. All functions OK. Full bill/box. Serious buyers only."
    },
    postingStrategy: [
      "Start near suggested; test first 48h.",
      "Weak interest? Drop ₹1–2k after 48–72h.",
      "Accept within band if leads are active."
    ],
    caveats: ["Heuristic only. Add more comps for sharper guidance."],
    compsUsed: [],
    sources: []
  };
};

// ─── AI calls ───────────────────────────────────────────────────────────
const callGemini = async (model, key, parts, timeoutMs = 12000) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 1100 }
  };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } finally {
    clearTimeout(t);
  }
};

const callWithFallback = async (models, key, parts) => {
  const tries = [];
  for (const m of models) {
    const r = await callGemini(m, key, parts);
    tries.push({ model: m, status: r.status, ok: r.ok, sample: r.text?.slice(0, 600) });
    if (r.ok) {
      let d; try { d = JSON.parse(r.text); } catch {}
      const txt = d?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return { success: true, model: m, txt, tries };
    }
  }
  return { success: false, tries };
};

// ─── Handler ────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return ok("");
  if (event.httpMethod !== "POST")    return err(405, "Method Not Allowed");

  try {
    // Basic input guards
    const { item = {}, comps = [] } = JSON.parse(event.body || "{}");

    const headersLower = Object.fromEntries(
      Object.entries(event.headers || {}).map(([k, v]) => [String(k).toLowerCase(), v])
    );
    const keyHeader = (headersLower["x-gemini-key"] || "").trim();
    const KEY = keyHeader || (process.env.GEMINI_API_KEY || GEMINI_KEY_FALLBACK || "").trim();
    const MODEL_HDR = (headersLower["x-gemini-model"] || "").trim();

    // Hard limits to avoid abuse
    const compsSafe = Array.isArray(comps) ? comps.slice(0, 40) : [];
    if (JSON.stringify(item).length > 12_000) return err(413, "item too large");
    if (JSON.stringify(compsSafe).length > 40_000) return err(413, "comps too large");

    // No key → heuristic response
    if (!KEY) {
      const fb = mkHeuristic(item);
      return ok({ ...fb, debug: { usedAI: false, reason: "missing_key" } });
    }

    const sys = `
You are a pricing analyst for an Indian classifieds marketplace.

Return JSON ONLY (no markdown). EXACT shape:
{
  "summary": "one paragraph",
  "priceBands": { "quick":0, "suggested":0, "patient":0, "median":0, "p25":0, "p75":0 },
  "marketNotes": "1–2 lines about India market context",
  "localReality": "1–2 lines reflecting the user's city/region",
  "factors": ["bullet points of why the price makes sense"],
  "listingCopy": { "title": "", "descriptionShort": "" },
  "postingStrategy": ["step 1","step 2","step 3"],
  "caveats": ["short bullet caveats"],
  "compsUsed": [{"title":"","price":0,"city":"","state":"","url":""}],
  "sources": [{"title":"","link":""}]
}
Rules:
- Prioritize provided COMPS; drop obvious outliers (>±40% from median where possible).
- All numbers are INR whole integers.
- If comps weak, derive cautious bands around user's anchor and add caveats.
- Output ONLY valid JSON.
`.trim();

    const parts = [
      { text: sys },
      { text: "ITEM:" },  { text: JSON.stringify(item || {}) },
      { text: "COMPS:" }, { text: JSON.stringify(compsSafe || []) }
    ];

    const list = MODEL_HDR ? [MODEL_HDR, ...MODEL_ORDER] : MODEL_ORDER;
    const ai = await callWithFallback(list, KEY, parts);

    if (!ai.success) {
      const fb = mkHeuristic(item);
      return ok({ ...fb, debug: { usedAI: false, tries: ai.tries } });
    }

    const parsed = forceJSON(ai.txt);
    if (!parsed || typeof parsed !== "object") {
      const fb = mkHeuristic(item);
      return ok({ ...fb, debug: { usedAI: true, parsedOK: false, model: ai.model } });
    }

    // sanitize numeric bands
    parsed.priceBands = sanitizeBands(parsed.priceBands);

    return ok({ ...parsed, debug: { usedAI: true, parsedOK: true, model: ai.model } });
  } catch (e) {
    // never leak stack in prod
    return ok({ error: "internal_error", message: String(e?.message || e), debug: { usedAI: false } });
  }
};
