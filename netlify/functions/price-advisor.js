// netlify/functions/price-advisor.js
// Node 18+ (Netlify default)
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

// === Keys (server-side only) ===
// (You asked to inline; still prefer env in production.)
const GEMINI_KEY = process.env.GEMINI_API_KEY || "AIzaSyD6Uvvth0RMC-I44K3vcan13JcSKPyIZrw";

// v1beta endpoint models that work today
const MODELS_TRY = ["gemini-2.5-flash", "gemini-1.5-pro"];

// ---------- helpers ----------
const ok = (body, headers = {}) => ({
  statusCode: 200,
  headers: {
    "content-type": "application/json",
    // lock to your domain (add preview domains if needed)
    "access-control-allow-origin": "https://bechobazaar.com",
    "access-control-allow-headers": "content-type,x-gemini-key,x-gemini-model",
    "access-control-allow-methods": "POST,OPTIONS",
    ...headers
  },
  body: typeof body === "string" ? body : JSON.stringify(body)
});
const err = (code, msg) => ok({ error: msg, code });

function forceJSON(t) {
  if (!t) return null;
  const s = String(t).trim();

  // Prefer explicit wrapper: <json> ... </json>
  const tag = s.match(/<json>\s*([\s\S]*?)\s*<\/json>/i);
  if (tag?.[1]) {
    try { return JSON.parse(tag[1].trim()); } catch {}
  }

  // Fallbacks: fenced or first {...} block
  const fence = s.match(/```json\s*([\s\S]*?)```/i) || s.match(/```\s*([\s\S]*?)```/i);
  if (fence?.[1]) { try { return JSON.parse(fence[1].trim()); } catch {} }

  const i = s.indexOf("{"), j = s.lastIndexOf("}");
  if (i !== -1 && j !== -1 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch {} }
  return null;
}

function bandsFromAnchor(p) {
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
}

function mkHeuristic(item) {
  const place = [item?.area, item?.city, item?.state].filter(Boolean).join(", ");
  return {
    summary: "Heuristic preview (AI unavailable).",
    priceBands: bandsFromAnchor(item?.price) || {},
    marketNotes: "Limited data; cautious ±8%.",
    localReality: place ? `Local demand considered for ${place}.` : "Locality unknown.",
    factors: [
      "Condition, age, storage variance (±5–12%).",
      "Box + bill + warranty improve resale potential.",
      "Good photos + battery/IMEI proof raise trust."
    ],
    listingCopy: {
      title: `${item?.brand || ""} ${item?.model || ""}${place ? " — " + place : ""}`,
      descriptionShort: "Clean condition. All functions OK. Full box/bill. Serious buyers only."
    },
    postingStrategy: [
      "Anchor slightly high; capture first 48h offers.",
      "No pings? Drop by ₹1–2k after 48–72h.",
      "Close within suggested band; carry bill/box for trust."
    ],
    caveats: ["Heuristic (AI not used). Add comps for sharper advice."],
    compsUsed: [],
    sources: []
  };
}

async function callGemini(model, key, parts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 1200 }
  };
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

async function callWithFallback(models, key, parts) {
  const tries = [];
  for (const m of models) {
    const res = await callGemini(m, key, parts);
    tries.push({ model: m, status: res.status, ok: res.ok, body: res.text.slice(0, 1000) });
    if (res.ok) {
      let d; try { d = JSON.parse(res.text); } catch {}
      const txt = d?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return { success: true, model: m, txt, tries };
    }
  }
  return { success: false, tries };
}

// ---------- handler ----------
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return ok("");
  if (event.httpMethod !== "POST")   return err(405, "Method Not Allowed");

  try {
    const { item, comps = [] } = JSON.parse(event.body || "{}");
    const hdr = Object.fromEntries(
      Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
    );
    const KEY = hdr["x-gemini-key"] || GEMINI_KEY;
    const OVERRIDE_MODEL = hdr["x-gemini-model"]; // optional override

    if (!KEY) {
      const fb = mkHeuristic(item);
      return ok({ ...fb, debug: { usedAI: false, reason: "missing_key" } });
    }

    // Strong JSON-only instruction with explicit wrapper
    const sys = `
You are a pricing analyst for an Indian classifieds marketplace.

OUTPUT CONTRACT:
- Reply with JSON ONLY, wrapped between <json> and </json>.
- No prose, markdown, or code fences outside the tags.

Exact schema:
{
  "summary": "one paragraph",
  "priceBands": { "quick":0, "suggested":0, "patient":0, "median":0, "p25":0, "p75":0 },
  "marketNotes": "1–2 lines about India market context",
  "localReality": "1–2 lines reflecting the user's city/region",
  "factors": ["reasons explaining the pricing"],
  "listingCopy": { "title":"", "descriptionShort":"" },
  "postingStrategy": ["step 1","step 2","step 3"],
  "caveats": ["short bullet caveats"],
  "compsUsed": [{"title":"","price":0,"city":"","state":"","url":""}],
  "sources": [{"title":"","link":""}]
}

Rules:
- Prefer provided COMPS; trim outliers.
- All price fields must be INR integers.
- If comps are weak, derive cautious bands around user's anchor price (if present) and explain caveats.
- Output ONLY: <json>{...}</json>.
`.trim();

    const parts = [
      { text: sys },
      { text: "ITEM:" },  { text: JSON.stringify(item || {}) },
      { text: "COMPS:" }, { text: JSON.stringify(comps || []) },
      { text: "Return ONLY <json>{...}</json>." }
    ];

    const models = OVERRIDE_MODEL ? [OVERRIDE_MODEL] : MODELS_TRY;
    const ai = await callWithFallback(models, KEY, parts);

    if (!ai.success) {
      const fb = mkHeuristic(item);
      return ok({ ...fb, debug: { usedAI: false, tries: ai.tries } });
    }

    const parsed = forceJSON(ai.txt);
    if (!parsed || typeof parsed !== "object") {
      const fb = mkHeuristic(item);
      return ok({ ...fb, debug: { usedAI: true, parsedOK: false } });
    }

    // sanitize numeric bands
    if (parsed.priceBands && typeof parsed.priceBands === "object") {
      for (const k of ["quick", "suggested", "patient", "median", "p25", "p75"]) {
        const v = Number(parsed.priceBands[k]);
        if (Number.isFinite(v)) parsed.priceBands[k] = Math.round(v);
        else delete parsed.priceBands[k];
      }
    }

    return ok({
      summary: parsed.summary || "",
      priceBands: parsed.priceBands || {},
      marketNotes: parsed.marketNotes || "",
      localReality: parsed.localReality || "",
      factors: parsed.factors || [],
      listingCopy: parsed.listingCopy || { title: "", descriptionShort: "" },
      postingStrategy: parsed.postingStrategy || [],
      caveats: parsed.caveats || [],
      compsUsed: Array.isArray(parsed.compsUsed) ? parsed.compsUsed.slice(0, 20) : [],
      sources: Array.isArray(parsed.sources) ? parsed.sources.slice(0, 20) : [],
      debug: { usedAI: true, parsedOK: true, model: ai.model }
    });

  } catch (e) {
    const fb = mkHeuristic((() => { try { return JSON.parse(event.body || "{}")?.item; } catch {} return {}; })());
    return ok({
      ...fb,
      caveats: [...(fb.caveats || []), "Function crashed; showing heuristic fallback."],
      debug: { usedAI: false, reason: "exception", error: String(e?.message || e) }
    });
  }
};
