// netlify/functions/price-advisor.js

const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const MODEL = "gemini-1.5-flash"; // v1beta generateContent supported
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// ---- small utils
const ok = (body, headers={}) => ({
  statusCode: 200,
  headers: {
    "content-type": "application/json",
    // CORS (both your domains)
    "access-control-allow-origin": "*", // or set to "https://bechobazaar.com"
    "access-control-allow-headers": "content-type,x-gemini-key,x-cse-key,x-cse-cx",
    "access-control-allow-methods": "POST, OPTIONS",
    ...headers
  },
  body: (typeof body === "string" ? body : JSON.stringify(body))
});

const err = (code, msg) => ok({ error: msg, code });

// robust JSON extractor (handles fenced blocks, trailing text, etc.)
function forceJSON(text) {
  if (!text) return null;
  // try direct
  try { return JSON.parse(text); } catch(_) {}

  // pick first ```json ... ``` block
  const m = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
  if (m && m[1]) {
    try { return JSON.parse(m[1]); } catch(_) {}
  }
  // find first { ... } balanced (simple fallback)
  const i = text.indexOf('{');
  const j = text.lastIndexOf('}');
  if (i !== -1 && j !== -1 && j > i) {
    const slice = text.slice(i, j + 1);
    try { return JSON.parse(slice); } catch(_) {}
  }
  return null;
}

// very light fallback bands if AI not available
function fallbackFromAnchor(anchor) {
  const p = Number(anchor || 0);
  if (!Number.isFinite(p) || p <= 0) return null;
  const bands = {
    quick: Math.round(p * 0.92),
    suggested: Math.round(p),
    patient: Math.round(p * 1.08),
    median: Math.round(p),
    p25: Math.round(p * 0.95),
    p75: Math.round(p * 1.05),
  };
  return bands;
}

async function googleCSESnippets(qArr, key, cx) {
  const out = [];
  for (const q of qArr) {
    try {
      const r = await fetch(
        `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&num=3&q=${encodeURIComponent(q)}`
      );
      if (!r.ok) continue;
      const data = await r.json();
      out.push({
        query: q,
        items: (data.items || []).map(it => ({
          title: it.title, link: it.link, snippet: it.snippet
        }))
      });
    } catch {}
  }
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return ok(""); // CORS preflight
  }
  if (event.httpMethod !== "POST") {
    return err(405, "Method Not Allowed");
  }

  try {
    const { item, comps = [], wantWeb = false } = JSON.parse(event.body || "{}");

    // pull keys from env or headers (headers win)
    const hdr = event.headers || {};
    const GEMINI_API_KEY = hdr["x-gemini-key"] || process.env.GEMINI_API_KEY || "";
    const CSE_KEY = hdr["x-cse-key"] || process.env.CSE_KEY || "";
    const CSE_CX  = hdr["x-cse-cx"]  || process.env.CSE_CX  || "";

    // optional web snippets
    let webSnippets = [];
    if (wantWeb && CSE_KEY && CSE_CX) {
      const qBase = [item?.brand, item?.model, item?.variant, "India price"].filter(Boolean).join(" ");
      const queries = [
        qBase,
        `${item?.brand || ""} ${item?.model || ""} used price India`,
        `${item?.brand || ""} ${item?.model || ""} resale value India`,
      ].filter(Boolean);
      webSnippets = await googleCSESnippets(queries, CSE_KEY, CSE_CX);
    }

    // If no key, return heuristic
    if (!GEMINI_API_KEY) {
      const fb = fallbackFromAnchor(item?.price);
      return ok({
        summary: "AI key missing on server. Showing heuristic based on your entered price. Add GEMINI_API_KEY (or send X-Gemini-Key header).",
        priceBands: fb || {},
        caveats: ["This is a heuristic preview. Configure Gemini for AI analysis."],
        compsUsed: comps.slice(0, 10),
        sources: webSnippets,
        debug: { usedAI: false, reason: "missing_key" }
      });
    }

    // Build strict prompt (return JSON only)
    const sys = `
You are a pricing analyst for an Indian classifieds marketplace.
TASK: Use provided comparables ("COMPS") first; use "PUBLIC_SNIPPETS" only as supporting signals.
Trim outliers, reason about condition/age/region if possible from titles/text.
Return INR whole numbers. Return three core bands: quick, suggested, patient. Also include median, p25, p75 if derivable.
Return STRICT JSON ONLY with this shape:

{
  "summary": "one-paragraph summary",
  "priceBands": { "quick": 0, "suggested": 0, "patient": 0, "median": 0, "p25": 0, "p75": 0 },
  "reasoningPoints": ["short bullets..."],
  "compsUsed": [{"title":"","price":0,"city":"","state":"","url":""}],
  "caveats": ["..."],
  "sources": [{"title":"","link":""}]
}

If not enough evidence, still produce bands using a conservative heuristic around the user's price, and add a clear caveat.
Numbers must be integers (no commas). Do not include any text outside JSON.
`;

    const userParts = [
      { text: sys.trim() },
      { text: "ITEM:" },
      { text: JSON.stringify(item || {}) },
      { text: "COMPS:" },
      { text: JSON.stringify(comps || []) },
      { text: "PUBLIC_SNIPPETS:" },
      { text: JSON.stringify(webSnippets || []) }
    ];

    const body = {
      contents: [{ role: "user", parts: userParts }],
      generationConfig: {
        temperature: 0.2,
        topP: 0.9,
        maxOutputTokens: 1024
      }
    };

    const resp = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const t = await resp.text();
      // fallback bands if API error
      const fb = fallbackFromAnchor(item?.price);
      return ok({
        summary: "Gemini error; using heuristic fallback.",
        priceBands: fb || {},
        caveats: ["Heuristic because AI call failed.", t.slice(0, 300)],
        compsUsed: comps.slice(0, 10),
        sources: webSnippets,
        debug: { usedAI: false, reason: "gemini_http_error", http: t }
      });
    }

    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    let parsed = forceJSON(text);
    if (!parsed || typeof parsed !== "object") {
      const fb = fallbackFromAnchor(item?.price);
      return ok({
        summary: "No structured AI output received. Using a conservative heuristic around your entered price.",
        priceBands: fb || {},
        caveats: ["AI replied without strict JSON. Prompt enforcer engaged; showing fallback bands."],
        compsUsed: comps.slice(0, 10),
        sources: webSnippets,
        debug: { usedAI: true, parsedOK: false, rawLen: text?.length || 0 }
      });
    }

    // sanitize numeric fields to integers
    if (parsed.priceBands && typeof parsed.priceBands === "object") {
      for (const k of ["quick","suggested","patient","median","p25","p75"]) {
        if (parsed.priceBands[k] != null) {
          const n = Number(parsed.priceBands[k]);
          if (Number.isFinite(n)) parsed.priceBands[k] = Math.round(n);
          else delete parsed.priceBands[k];
        }
      }
    }

    return ok({
      summary: parsed.summary || "",
      priceBands: parsed.priceBands || {},
      reasoning: parsed.reasoningPoints || [],
      caveats: parsed.caveats || [],
      compsUsed: Array.isArray(parsed.compsUsed) ? parsed.compsUsed.slice(0, 20) : [],
      sources: Array.isArray(parsed.sources) ? parsed.sources.slice(0, 20) : [],
      debug: { usedAI: true, parsedOK: true }
    });

  } catch (e) {
    const fb = fallbackFromAnchor(
      (() => { try { return JSON.parse(event.body||"{}")?.item?.price } catch { return 0; }})()
    );
    return ok({
      summary: "Server error; showing heuristic fallback.",
      priceBands: fb || {},
      caveats: ["Heuristic because server crashed.", String(e?.message || e)],
      compsUsed: [],
      sources: [],
      debug: { usedAI: false, reason: "exception" }
    });
  }
};
