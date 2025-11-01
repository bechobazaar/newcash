// netlify/functions/price-advisor.js

// ============= CONFIG (edit these) =============
const HARD_GEMINI_KEY = "AIzaSyD6Uvvth0RMC-I44K3vcan13JcSKPyIZrw"; // <-- put your key
const HARD_CSE_KEY    = "";   // optional (Google Custom Search)
const HARD_CSE_CX     = "";   // optional (Google Custom Search CX)

// Allowed front-end origins
const ORIGIN_ALLOW = new Set([
  "https://bechobazaar.com",
  "https://www.bechobazaar.com",
  "https://bechobazaar.netlify.app",
  "http://localhost:8888",
  "http://127.0.0.1:5500",
]);

// Gemini v1 endpoint (pick one)
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1/models/gemini-1.5-pro:generateContent";
// Cheaper option:
// const GEMINI_ENDPOINT =
//   "https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash-002:generateContent";

// ============= UTILITIES =============
let __hits = 0;
let __winStart = Date.now();
const MAX_HITS = 300;           // per window
const WINDOW_MS = 5 * 60 * 1000;

function corsHeaders(origin) {
  const allow = ORIGIN_ALLOW.has(origin) ? origin : "";
  return {
    "access-control-allow-origin": allow,  // empty => browser will block
    "access-control-allow-methods": "POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json",
  };
}

function respond(statusCode, body, origin, extra = {}) {
  return {
    statusCode,
    headers: { ...corsHeaders(origin), ...extra },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

function tryParseJsonFromText(text) {
  if (!text) return null;
  // 1) direct
  try { return JSON.parse(text); } catch {}
  // 2) fenced code block
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (m) {
    try { return JSON.parse(m[1]); } catch {}
  }
  // 3) first { ... } block
  const i = text.indexOf("{");
  const j = text.lastIndexOf("}");
  if (i >= 0 && j > i) {
    try { return JSON.parse(text.slice(i, j + 1)); } catch {}
  }
  return null;
}

// ============= HANDLER =============
exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || "";

  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(origin), body: "" };
  }

  // Enforce CORS allow-list (still return CORS headers for clarity)
  if (origin && !ORIGIN_ALLOW.has(origin)) {
    return respond(403, { error: "Forbidden (origin)" }, origin);
  }

  // Only POST
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method Not Allowed" }, origin);
  }

  // Simple rate-limit
  const now = Date.now();
  if (now - __winStart > WINDOW_MS) {
    __winStart = now;
    __hits = 0;
  }
  if (++__hits > MAX_HITS) {
    return respond(429, { error: "Too Many Requests" }, origin);
  }

  try {
    const { item, comps, wantWeb = true } = JSON.parse(event.body || "{}");

    // Optional: Google Custom Search web snippets
    const CSE_KEY = process.env.CSE_KEY || HARD_CSE_KEY;
    const CSE_CX  = process.env.CSE_CX  || HARD_CSE_CX;
    let webSnippets = [];

    if (wantWeb && CSE_KEY && CSE_CX) {
      const qBase = [item?.brand, item?.model, item?.variant, "India price"]
        .filter(Boolean)
        .join(" ");
      const queries = [
        qBase,
        `${item?.brand || ""} ${item?.model || ""} launch price India`,
        `${item?.brand || ""} ${item?.model || ""} used price India`,
      ].filter(Boolean);

      for (const q of queries) {
        try {
          const r = await fetch(
            `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(
              CSE_KEY
            )}&cx=${encodeURIComponent(CSE_CX)}&num=3&q=${encodeURIComponent(q)}`
          );
          if (r.ok) {
            const data = await r.json();
            webSnippets.push({
              query: q,
              items: (data.items || []).map((it) => ({
                title: it.title,
                link: it.link,
                snippet: it.snippet,
              })),
            });
          }
        } catch {
          // ignore snippet fetch errors
        }
      }
    }

    // Gemini API key
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY || HARD_GEMINI_KEY;
    if (!GEMINI_API_KEY) {
      return respond(500, { error: "Missing GEMINI_API_KEY" }, origin);
    }

    // Prompt-only JSON contract (no schema keys)
    const prompt = `You are a pricing analyst for an Indian classifieds marketplace.
Use COMPARABLE_LISTINGS first; PUBLIC_SNIPPETS only as context. Trim outliers (approx 10–90 percentile).
Output INR whole numbers only.

Return a STRICT JSON object with keys:
- "priceBands": { "quick": number, "suggested": number, "patient": number, "median": number, "p25": number, "p75": number }
- "summary": string
- "reportMd": string (Hinglish markdown with sections: "Launch aur market reference", "Aapki specific item details", "Suggested selling price", "Why this estimate")
- "reasoningPoints": string[] (2–6 bullets)
- "compsUsed": array of { "title": string, "price": number, "brand": string, "model": string, "city": string, "state": string, "postedAt": string, "url": string }
- "sources": array of { "title": string, "link": string, "snippet": string }

Constraints:
- ONLY return JSON. No extra commentary.
- Prices must be integers in INR (no decimals or currency words).
- If unsure about a field, omit it rather than guessing wildly.`;

    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { text: "ITEM:" },
            { text: JSON.stringify(item || {}) },
            { text: "COMPARABLE_LISTINGS:" },
            { text: JSON.stringify(comps || []) },
            { text: "PUBLIC_SNIPPETS:" },
            { text: JSON.stringify(webSnippets) },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        topP: 0.9,
        maxOutputTokens: 1400,
        // IMPORTANT: Do NOT send responseSchema/responseMimeType for v1 here.
      },
    };

    const resp = await fetch(
      `${GEMINI_ENDPOINT}?key=${encodeURIComponent(GEMINI_API_KEY)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }
    );

    if (!resp.ok) {
      const t = await resp.text();
      return respond(502, { error: `Gemini error: ${t}` }, origin);
    }

    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // Try to parse JSON from the text (handles code fences too)
    const parsed = tryParseJsonFromText(text);
    if (!parsed) {
      return respond(502, { error: "AI returned non-JSON or unparsable JSON", raw: text }, origin);
    }

    return respond(200, parsed, origin, { "content-type": "application/json" });
  } catch (e) {
    return respond(500, { error: String(e?.message || e) }, origin);
  }
};
