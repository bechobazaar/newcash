// netlify/functions/price-advisor.js

// ✅ Supported model + endpoint (v1beta)
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

// ✅ CORS allow your sites
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

// ✅ Fallback key to avoid env size problem (keep repo PRIVATE)
const GEMINI_FALLBACK_KEY = [
  // 👉 Replace with your real key (can be whole or split into parts)
  "AIzaSyD6Uvvth0RMC-I44K3vcan13JcSKPyIZrw"
].join("");

function resolveGeminiKey(event) {
  return (
    process.env.GEMINI_API_KEY ||
    event.headers["x-gemini-key"] || // optional header path
    GEMINI_FALLBACK_KEY ||
    ""
  );
}

// ---------- Helpers ----------

// Extract JSON from messy model output
function extractJSON(text) {
  if (!text || typeof text !== "string") return null;

  // 1) Fenced ```json … ```
  const fence = text.match(/```json([\s\S]*?)```/i);
  if (fence && fence[1]) {
    try { return JSON.parse(fence[1].trim()); } catch {}
  }
  // 2) First {...} block
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const slice = text.slice(firstBrace, lastBrace + 1);
    try { return JSON.parse(slice); } catch {}
  }
  // 3) Pure JSON attempt
  try { return JSON.parse(text.trim()); } catch {}
  return null;
}

// Median
function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}
// Percentile (p in [0,100])
function percentile(arr, p) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const idx = (p / 100) * (a.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return a[lo];
  const w = idx - lo;
  return Math.round(a[lo] * (1 - w) + a[hi] * w);
}
// Remove outliers via IQR
function removeOutliers(nums) {
  if (nums.length < 5) return nums;
  const a = [...nums].sort((x, y) => x - y);
  const q1 = percentile(a, 25);
  const q3 = percentile(a, 75);
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  return a.filter((v) => v >= lo && v <= hi);
}
// Build fallback result from comps
function buildFallbackFromComps(comps) {
  const prices = (comps || [])
    .map((c) => Number(c.price))
    .filter((n) => Number.isFinite(n) && n > 0);

  if (!prices.length) {
    return null;
  }
  const cleaned = removeOutliers(prices);
  if (!cleaned.length) return null;

  const med = median(cleaned);
  const p25 = percentile(cleaned, 25);
  const p75 = percentile(cleaned, 75);

  // Heuristics for quick/suggested/patient
  const suggested = med;
  const quick = Math.round((p25 + suggested) / 2);     // slightly below middle
  const patient = Math.round((p75 + suggested) / 2);   // slightly above middle

  return {
    summary: "Estimated from comparable listings (AI unavailable).",
    priceBands: { quick, suggested, patient, median: med, p25, p75 },
    reasoning: [
      "Computed median and IQR from comparable listings.",
      "Removed outliers using 1.5×IQR rule.",
    ],
    caveats: [
      "Fallback used because AI response was empty or non-JSON.",
      "Adjust for condition, accessories, warranty, and urgency.",
    ],
    sources: [],
    debug: { derivedFrom: cleaned.length, rawCount: prices.length },
  };
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

    // Optional: Google CSE snippets
    let webSnippets = [];
    const CSE_KEY = process.env.CSE_KEY;
    const CSE_CX  = process.env.CSE_CX;
    if (wantWeb && CSE_KEY && CSE_CX) {
      const qBase = [item.brand, item.model, item.variant, "India price"]
        .filter(Boolean).join(" ");
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
              items: (data.items || []).map(it => ({
                title: it.title, link: it.link, snippet: it.snippet
              })),
            });
          }
        } catch {}
      }
    }

    // Resolve key
    const key = resolveGeminiKey(event);
    if (!key) {
      // If no key, try fallback from comps right away
      const fb = buildFallbackFromComps(comps);
      return {
        statusCode: 200,
        headers: { ...baseHeaders, "content-type": "application/json" },
        body: JSON.stringify(
          fb || { error: "Missing GEMINI_API_KEY and no comps available." }
        ),
      };
    }

    // Prompt designed to force a minified JSON only
    const prompt = [
      "You are a pricing analyst for an Indian classifieds marketplace.",
      "Use COMPARABLE_LISTINGS first. Use PUBLIC_SNIPPETS only for context. Drop obvious outliers.",
      "All prices must be INR whole numbers.",
      "Return EXACTLY this minified JSON shape and NOTHING else:",
      `{"summary":"...","priceBands":{"quick":0,"suggested":0,"patient":0,"median":0,"p25":0,"p75":0},"reasoning":["..."],"caveats":["..."],"sources":[{"title":"...","link":"..."}]}`,
      "If you cannot compute some fields, omit only those keys (do not write null).",
    ].join(" ");

    const contents = [{
      role: "user",
      parts: [
        { text: prompt },
        { text: "ITEM:\n" + JSON.stringify(item || {}) },
        { text: "COMPARABLE_LISTINGS:\n" + JSON.stringify(comps || []) },
        { text: "PUBLIC_SNIPPETS:\n" + JSON.stringify(webSnippets || []) },
        { text: "Return ONLY minified JSON. No extra text. No code fences." },
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
      // Try fallback from comps
      const fb = buildFallbackFromComps(comps);
      return {
        statusCode: 200,
        headers: { ...baseHeaders, "content-type": "application/json" },
        body: JSON.stringify(
          fb || { error: `Gemini error: ${t}` }
        ),
      };
    }

    const data = await resp.json();
    const candidate = data?.candidates?.[0];
    const partText = candidate?.content?.parts?.[0]?.text || "";

    // Try to parse strict JSON
    let parsed = extractJSON(partText);

    // If still nothing, use comps fallback
    if (!parsed) {
      const fb = buildFallbackFromComps(comps);
      if (fb) {
        fb.debug = {
          ...(fb.debug || {}),
          note: "AI returned non-JSON; fallback used.",
          finishReason: candidate?.finishReason,
          safetyRatings: candidate?.safetyRatings,
          raw: partText?.slice(0, 1200) || "",
        };
        return {
          statusCode: 200,
          headers: { ...baseHeaders, "content-type": "application/json" },
          body: JSON.stringify(fb),
        };
      }
      // Last resort: send debug so you can see what came back
      return {
        statusCode: 200,
        headers: { ...baseHeaders, "content-type": "application/json" },
        body: JSON.stringify({
          summary: "No structured AI output and no comparable listings available.",
          priceBands: {},
          reasoning: [],
          caveats: ["Model output could not be parsed as JSON."],
          sources: [],
          debug: {
            finishReason: candidate?.finishReason,
            safetyRatings: candidate?.safetyRatings,
            raw: partText?.slice(0, 1200) || "",
          },
        }),
      };
    }

    // Attach debug info (useful to see why earlier you got {})
    parsed.debug = {
      ...(parsed.debug || {}),
      finishReason: candidate?.finishReason,
      safetyRatings: candidate?.safetyRatings,
      raw: partText?.slice(0, 600) || "",
    };

    return {
      statusCode: 200,
      headers: { ...baseHeaders, "content-type": "application/json" },
      body: JSON.stringify(parsed),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: baseHeaders,
      body: JSON.stringify({ error: String(e?.message || e) }),
    };
  }
};
