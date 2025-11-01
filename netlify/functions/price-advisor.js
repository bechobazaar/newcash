// netlify/functions/price-advisor.js

// ✅ Current, supported model/endpoint
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

// ✅ Allow your sites
const ALLOWED_ORIGINS = [
  "https://bechobazaar.com",
  "https://www.bechobazaar.com",
  "https://bechobazaar.netlify.app",
];

const corsHeaders = (origin) => ({
  "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Gemini-Key",
  Vary: "Origin",
});

// ✅ LAST-RESORT key: paste your key here (keep this file private).
// You can either keep it whole, or split in parts and join.
// EXAMPLE (replace with your real key pieces):
const GEMINI_FALLBACK_KEY = [
  "AIzaSyD6Uvvth0RMC-I44K3vcan13JcSKPyIZrw"
].join("");

// Prefer ENV > Header > Fallback
function resolveGeminiKey(event) {
  return (
    process.env.GEMINI_API_KEY ||
    event.headers["x-gemini-key"] ||
    GEMINI_FALLBACK_KEY ||
    ""
  );
}

exports.handler = async (event) => {
  const origin = event.headers.origin || "";
  const baseHeaders = corsHeaders(origin);

  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: baseHeaders, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: baseHeaders, body: "Method Not Allowed" };
  }

  try {
    const { item = {}, comps = [], wantWeb = true } = JSON.parse(event.body || "{}");

    // (Optional) Google CSE snippets for grounding if you add CSE_KEY/CSE_CX in Netlify env
    let webSnippets = [];
    const CSE_KEY = process.env.CSE_KEY;
    const CSE_CX  = process.env.CSE_CX;
    if (wantWeb && CSE_KEY && CSE_CX) {
      const qBase = [item.brand, item.model, item.variant, "India price"].filter(Boolean).join(" ");
      const queries = [
        qBase,
        `${item.brand || ""} ${item.model || ""} used price India`,
        `${item.brand || ""} ${item.model || ""} resale price`,
      ];
      for (const q of queries) {
        try {
          const r = await fetch(
            `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(CSE_KEY)}&cx=${encodeURIComponent(CSE_CX)}&num=3&q=${encodeURIComponent(q)}`
          );
          if (r.ok) {
            const data = await r.json();
            webSnippets.push({
              query: q,
              items: (data.items || []).map(it => ({ title: it.title, link: it.link, snippet: it.snippet })),
            });
          }
        } catch {}
      }
    }

    const key = resolveGeminiKey(event);
    if (!key) {
      return {
        statusCode: 500,
        headers: baseHeaders,
        body: JSON.stringify({ error: "Missing GEMINI_API_KEY (env/header/fallback)" }),
      };
    }

    // Strict JSON via prompt (no responseSchema in v1beta)
    const prompt = [
      "You are a pricing analyst for an Indian classifieds marketplace.",
      "Use COMPARABLE_LISTINGS first; PUBLIC_SNIPPETS only for context; drop outliers.",
      "All prices in INR whole numbers.",
      "Return three bands: quick (sell fast), suggested (balanced), patient (max value).",
      "Include median/p25/p75 if derivable. Add reasoning bullets, caveats, and sources.",
      "Return STRICT minified JSON ONLY with keys:",
      "{summary, priceBands:{quick,suggested,patient,median?,p25?,p75?}, reasoning:[], caveats:[], sources:[{title,link}]}",
    ].join(" ");

    const contents = [{
      role: "user",
      parts: [
        { text: prompt },
        { text: "ITEM:\n" + JSON.stringify(item || {}) },
        { text: "COMPARABLE_LISTINGS:\n" + JSON.stringify(comps || []) },
        { text: "PUBLIC_SNIPPETS:\n" + JSON.stringify(webSnippets || []) },
        { text: "Return ONLY minified JSON. No prose." },
      ],
    }];

    const resp = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents,
        generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 1024 },
      }),
    });

    if (!resp.ok) {
      const t = await resp.text();
      return { statusCode: 502, headers: baseHeaders, body: JSON.stringify({ error: `Gemini error: ${t}` }) };
    }

    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

    return {
      statusCode: 200,
      headers: { ...baseHeaders, "content-type": "application/json" },
      body: JSON.stringify(json),
    };
  } catch (e) {
    return { statusCode: 500, headers: baseHeaders, body: JSON.stringify({ error: String(e?.message || e) }) };
  }
};
