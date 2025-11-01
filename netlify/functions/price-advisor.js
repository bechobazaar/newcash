// netlify/functions/price-advisor.js
// CORS + Gemini + (optional) Google CSE snippets

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

// ---- tiny helpers ----
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Gemini-Key",
    "Access-Control-Max-Age": "86400",
    "Content-Type": "application/json",
  };
}

// safe number
const toNum = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

// basic heuristic bands (when no data)
function fallbackBands(seedPrice) {
  const p = Math.max(1, toNum(seedPrice) || 1);
  return {
    quick: Math.round(p * 0.92),
    suggested: Math.round(p),
    patient: Math.round(p * 1.08),
    median: Math.round(p),
    p25: Math.round(p * 0.95),
    p75: Math.round(p * 1.05),
  };
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || "*";

  // ---- CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(origin), body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders(origin),
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  try {
    const { item = {}, comps = [], wantWeb = false } = JSON.parse(event.body || "{}");

    // --------- (Optional) Google Custom Search snippets ----------
    let webSnippets = [];
    const CSE_KEY = process.env.CSE_KEY;
    const CSE_CX = process.env.CSE_CX;

    if (wantWeb && CSE_KEY && CSE_CX) {
      const qBase = [item.brand, item.model, item.category, "India price"]
        .filter(Boolean)
        .join(" ");
      const queries = [
        qBase,
        `${item.brand || ""} ${item.model || ""} second hand price India`,
        `${item.brand || ""} ${item.model || ""} used price in ${item.city || ""} ${item.state || ""}`,
      ];
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
        } catch {}
      }
    }

    // ---------- Gemini ----------
    // You can supply API key in three ways (priority order):
    //  1) netlify env var GEMINI_API_KEY
    //  2) secret header X-Gemini-Key (from your frontend or Postman)
    //  3) (NOT RECOMMENDED) hardcoded fallback string below
    const hdrKey = event.headers?.["x-gemini-key"] || event.headers?.["X-Gemini-Key"];
    const GEMINI_API_KEY =
      process.env.GEMINI_API_KEY ||
      hdrKey ||
      ""; // keep empty here; DO NOT hardcode public keys

    if (!GEMINI_API_KEY) {
      // Still respond with safe fallback so UI shows something
      const bands = fallbackBands(item.price);
      return {
        statusCode: 200,
        headers: corsHeaders(origin),
        body: JSON.stringify({
          summary:
            "AI key missing on server. Showing heuristic based on your entered price. Add GEMINI_API_KEY or send X-Gemini-Key header.",
          priceBands: bands,
          caveats: [
            "This is a heuristic preview. Configure GEMINI_API_KEY on Netlify for AI analysis.",
          ],
          compsUsed: comps.slice(0, 8),
          sources: webSnippets,
          debug: { reason: "missing_gemini_key" },
        }),
      };
    }

    const prompt = [
      "You are a pricing analyst for an Indian classifieds marketplace.",
      "Input includes the item, comparable listings (from our DB), and optional public web snippets.",
      "Task:",
      "- Use comps first; ignore obvious outliers.",
      "- Consider city/state and India market only.",
      "- Derive INR whole-number price bands: quick (lower), suggested (mid), patient (higher).",
      "- Also compute percentile-ish anchors (median, p25, p75) if possible.",
      "- If comps are empty, base ranges on the given price but state that it’s heuristic.",
      "Output strictly JSON with keys:",
      "{ summary: string, priceBands: { quick, suggested, patient, median, p25, p75 },",
      "  reasoning: string[], caveats: string[], sources: object[] }",
      "No extra prose outside JSON.",
    ].join("\n");

    const body = {
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { text: "ITEM_JSON:\n" + JSON.stringify(item || {}) },
            { text: "COMPARABLE_LISTINGS_JSON:\n" + JSON.stringify(comps || []) },
            { text: "PUBLIC_SNIPPETS_JSON:\n" + JSON.stringify(webSnippets || []) },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        topP: 0.9,
        maxOutputTokens: 1024,
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
      // Return graceful fallback so UI doesn’t break
      return {
        statusCode: 200,
        headers: corsHeaders(origin),
        body: JSON.stringify({
          summary:
            "No structured AI output received. Using a conservative heuristic around your entered price.",
          priceBands: fallbackBands(item.price),
          caveats: [
            "AI call failed; check model name, quota, or API key.",
            `Upstream: ${t.slice(0, 200)}...`,
          ],
          compsUsed: comps.slice(0, 8),
          sources: webSnippets,
          debug: { reason: "gemini_call_failed" },
        }),
      };
    }

    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    if (!parsed || typeof parsed !== "object") {
      return {
        statusCode: 200,
        headers: corsHeaders(origin),
        body: JSON.stringify({
          summary:
            "No structured AI output; returning heuristic bands based on your entered price.",
          priceBands: fallbackBands(item.price),
          caveats: ["AI returned non-JSON output."],
          compsUsed: comps.slice(0, 8),
          sources: webSnippets,
          debug: { reason: "ai_non_json" },
        }),
      };
    }

    // sanitize bands
    const pb = parsed.priceBands || {};
    const safeBands = {
      quick: toNum(pb.quick) || undefined,
      suggested: toNum(pb.suggested) || toNum(item.price) || undefined,
      patient: toNum(pb.patient) || undefined,
      median: toNum(pb.median) || toNum(item.price) || undefined,
      p25: toNum(pb.p25) || undefined,
      p75: toNum(pb.p75) || undefined,
    };

    const out = {
      summary: parsed.summary || "",
      priceBands: safeBands,
      reasoning: Array.isArray(parsed.reasoning) ? parsed.reasoning : [],
      caveats: Array.isArray(parsed.caveats) ? parsed.caveats : [],
      sources: Array.isArray(parsed.sources) ? parsed.sources : [],
      compsUsed: (Array.isArray(comps) ? comps : []).slice(0, 25),
      debug: { model: "gemini-1.5-flash", haveWeb: !!(CSE_KEY && CSE_CX && wantWeb) },
    };

    // fill minimal when bands missing
    if (!out.priceBands.suggested) out.priceBands = fallbackBands(item.price);

    return {
      statusCode: 200,
      headers: corsHeaders(origin),
      body: JSON.stringify(out),
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers: corsHeaders(origin),
      body: JSON.stringify({
        summary: "Server error; using heuristic bands.",
        priceBands: fallbackBands( Number(JSON.parse(event.body||"{}")?.item?.price || 0) ),
        caveats: ["Internal function error: " + (e?.message || e)],
        compsUsed: [],
        sources: [],
        debug: { reason: "server_exception" },
      }),
    };
  }
};
