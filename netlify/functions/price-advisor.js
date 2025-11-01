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

// Gemini v1 endpoints (use one)
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

    // Response schema (IMPORTANT: non-empty object properties)
    const schema = {
      type: "object",
      properties: {
        summary: { type: "string" },
        reportMd: { type: "string" },
        priceBands: {
          type: "object",
          properties: {
            quick: { type: "number" },
            suggested: { type: "number" },
            patient: { type: "number" },
            median: { type: "number" },
            p25: { type: "number" },
            p75: { type: "number" },
          },
          required: ["suggested"],
        },
        reasoningPoints: { type: "array", items: { type: "string" } },
        compsUsed: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              price: { type: "number" },
              brand: { type: "string" },
              model: { type: "string" },
              city: { type: "string" },
              state: { type: "string" },
              postedAt: { type: "string" }, // ISO string or text
              url: { type: "string" },
            },
            required: ["title", "price"],
          },
        },
        caveats: { type: "array", items: { type: "string" } },
        sources: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              link: { type: "string" },
              snippet: { type: "string" },
            },
            required: ["title"],
          },
        },
      },
      required: ["priceBands", "summary"],
    };

    const prompt = `You are a pricing analyst for an Indian classifieds marketplace.
Use COMPARABLE_LISTINGS first; PUBLIC_SNIPPETS only as context.
Trim outliers (approx 10–90 percentile band). Output INR whole numbers only.

Return three bands: quick / suggested / patient (+ median, p25, p75).
Also write a short human-friendly report in Hinglish (markdown) with sections:
- "Launch aur market reference" (1–2 bullets, cite snippets where useful)
- "Aapki specific item details" (bullets using item fields; call out assumptions)
- "Suggested selling price" (3 bullet lines with INR)
- "Why this estimate" (2–4 bullets)

In JSON, include:
- priceBands
- summary
- reportMd
- reasoningPoints (bullets)
- compsUsed: array of {title, price, brand, model, city, state, postedAt, url}
- sources: array of {title, link, snippet}

Return JSON only (no prose outside JSON).`;

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
        // v1 expects camelCase:
        responseMimeType: "application/json",
        responseSchema: schema,
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
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

    // Return the model JSON as-is
    return respond(200, text, origin, { "content-type": "application/json" });
  } catch (e) {
    return respond(500, { error: String(e?.message || e) }, origin);
  }
};
