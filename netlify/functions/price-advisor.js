// netlify/functions/price-advisor.js

// ====== SERVER-ONLY KEYS (fallback) ======
const HARD_GEMINI_KEY = "AIzaSyD6Uvvth0RMC-I44K3vcan13JcSKPyIZrw"; // <— yahan apni key भरो
const HARD_CSE_KEY    = ""; // optional
const HARD_CSE_CX     = ""; // optional

// ====== Allowed origins (add both your domains) ======
const ORIGIN_ALLOW = new Set([
  "https://bechobazaar.com",
  "https://www.bechobazaar.com",
  "https://bechobazaar.netlify.app",
  "http://localhost:8888",
  "http://127.0.0.1:5500"
]);

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent";

// very light in-memory rate-limit
let __hits = 0, __start = Date.now();
const MAX_HITS = 300, WINDOW_MS = 5 * 60 * 1000;

function corsHeaders(origin) {
  const allow = ORIGIN_ALLOW.has(origin) ? origin : "";
  return {
    "access-control-allow-origin": allow || "",     // if not allowed -> empty (browser will block)
    "access-control-allow-methods": "POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json"
  };
}

function respond(statusCode, body, origin, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...corsHeaders(origin), ...extraHeaders },
    body: typeof body === "string" ? body : JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  const origin = event.headers.origin || event.headers.Origin || "";

  // OPTIONS preflight — ALWAYS return CORS headers
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders(origin),
      body: ""
    };
  }

  // check origin early (but still send CORS headers so browser sees explicit block)
  if (origin && !ORIGIN_ALLOW.has(origin)) {
    return respond(403, { error: "Forbidden (origin)" }, origin);
  }

  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method Not Allowed" }, origin);
  }

  // rate-limit
  const now = Date.now();
  if (now - __start > WINDOW_MS) { __start = now; __hits = 0; }
  if (++__hits > MAX_HITS) {
    return respond(429, { error: "Too Many Requests" }, origin);
  }

  try {
    const { item, comps, wantWeb = true } = JSON.parse(event.body || "{}");

    // Optional: Google Custom Search snippets
    let webSnippets = [];
    const CSE_KEY = process.env.CSE_KEY || HARD_CSE_KEY;
    const CSE_CX  = process.env.CSE_CX  || HARD_CSE_CX;

    if (wantWeb && CSE_KEY && CSE_CX) {
      const qBase = [item?.brand, item?.model, item?.variant, "India price"]
        .filter(Boolean).join(" ");
      const queries = [
        qBase,
        `${item?.brand || ""} ${item?.model || ""} launch price India`,
        `${item?.brand || ""} ${item?.model || ""} used price India`,
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
              }))
            });
          }
        } catch { /* ignore */ }
      }
    }

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY || HARD_GEMINI_KEY;
    if (!GEMINI_API_KEY) {
      // Return error BUT with CORS headers so browser doesn’t show CORS failure
      return respond(500, { error: "Missing GEMINI_API_KEY" }, origin);
    }

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
        p75: { type: "number" }
      },
      required: ["suggested"]
    },
    reasoningPoints: { type: "array", items: { type: "string" } },

    // 👇 IMPORTANT: give non-empty properties here
    compsUsed: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          price: { type: "number" },
          brand: { type: "string" },
          model: { type: "string" },
          city:  { type: "string" },
          state: { type: "string" },
          postedAt: { type: "string" },     // ISO date or human text—model may emit string
          url: { type: "string" }            // optional link if inferred from snippet
        },
        required: ["title", "price"]
      }
    },

    caveats: { type: "array", items: { type: "string" } },
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          link:  { type: "string" },
          snippet: { type: "string" }
        },
        required: ["title"]
      }
    }
  },
  required: ["priceBands","summary"]
};


    const prompt =
`You are a pricing analyst for an Indian classifieds marketplace.
Use COMPARABLE_LISTINGS first; PUBLIC_SNIPPETS only as context.
Trim outliers (approx 10–90 percentile band). Output INR whole numbers.

Return three bands: quick / suggested / patient (+ median, p25, p75).
Also write a human-friendly short report in Hinglish (markdown) with sections:
- "Launch aur market reference" (1–2 bullets, cite snippets)
- "Aapki specific item details" (bullets using item fields, positive assumptions clear)
- "Suggested selling price" (3 bullet lines)
- "Why this estimate" (2–4 bullets)
Return JSON only → keys: priceBands, summary, reportMd, reasoningPoints, sources.`;

    const body = {
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { text: "ITEM:" },               { text: JSON.stringify(item || {}) },
          { text: "COMPARABLE_LISTINGS:" },{ text: JSON.stringify(comps || []) },
          { text: "PUBLIC_SNIPPETS:" },    { text: JSON.stringify(webSnippets) }
        ]
      }],
      generationConfig: {
        temperature: 0.2, topP: 0.9, maxOutputTokens: 1400,
        responseMimeType: "application/json", responseSchema: schema
      }
    };

    const resp = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const t = await resp.text();
      // Still return CORS headers
      return respond(502, { error: `Gemini error: ${t}` }, origin);
    }

    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    return respond(200, text, origin, { "content-type": "application/json" });

  } catch (e) {
    return respond(500, { error: String(e?.message || e) }, origin);
  }
};
