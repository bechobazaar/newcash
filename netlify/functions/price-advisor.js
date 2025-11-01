// netlify/functions/price-advisor.js
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

exports.handler = async (event) => {
  // CORS
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "access-control-allow-origin": "https://bechobazaar.com",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type, x-gemini-key"
      },
      body: ""
    };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const corsHeaders = {
    "access-control-allow-origin": "https://bechobazaar.com",
    "content-type": "application/json"
  };

  try {
    const { item = {}, comps = [], wantWeb = true } = JSON.parse(event.body || "{}");

    // ------ (A) Optional web snippets via CSE ------
    let webSnippets = [];
    const CSE_KEY = process.env.CSE_KEY || "";
    const CSE_CX  = process.env.CSE_CX  || "";
    if (wantWeb && CSE_KEY && CSE_CX) {
      const qBase = [item.brand, item.model, item.variant, "India price"]
        .filter(Boolean).join(" ");
      const queries = [
        qBase,
        `${item.brand || ""} ${item.model || ""} launch price India`,
        `${item.brand || ""} ${item.model || ""} used price India`
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
        } catch (_) {}
      }
    }

    // ------ (B) Gemini (key priority: header -> env -> inline fallback) ------
    const headerKey = (event.headers["x-gemini-key"] || event.headers["X-Gemini-Key"] || "").trim();
    const envKey    = (process.env.GEMINI_API_KEY || "").trim();
    const INLINE_FALLBACK = ""; // leave empty; you can paste a key here if you must
    const GEMINI_API_KEY = headerKey || envKey || INLINE_FALLBACK;

    // Helper: compute bands from comps
    function computeBandsFromComps(list) {
      const prices = (list || [])
        .map(x => Number(x.price || 0))
        .filter(v => Number.isFinite(v) && v > 0)
        .sort((a,b)=>a-b);
      if (!prices.length) return null;
      const p = (k) => {
        if (!prices.length) return null;
        const idx = Math.max(0, Math.min(prices.length - 1, Math.round((k/100)*(prices.length-1))));
        return Math.round(prices[idx]);
      };
      const median = p(50);
      const p25 = p(25);
      const p75 = p(75);
      // Quick/Patient around quartiles
      return {
        quick: Math.round(p25 || median || prices[0]),
        suggested: Math.round(median || p50),
        patient: Math.round(p75 || median || prices[prices.length-1]),
        median, p25, p75
      };
    }

    // Helper: heuristic bands from user price when nothing else is available
    function heuristicBandsFromUser(userPrice) {
      const n = Math.max(1, Number(userPrice || 0));
      const quick = Math.round(n * 0.92);
      const suggested = Math.round(n);
      const patient = Math.round(n * 1.08);
      return {
        quick, suggested, patient,
        median: suggested,
        p25: Math.round(n * 0.95),
        p75: Math.round(n * 1.05)
      };
    }

    // Try Gemini if a key exists
    let aiJson = null;
    if (GEMINI_API_KEY) {
      const prompt =
`You are a pricing analyst for an Indian classifieds marketplace.
Use comparable listings first; public snippets only as weak context.
Trim outliers. Return INR whole numbers and three bands: quick/suggested/patient.
JSON only. Keys: summary, priceBands{quick,suggested,patient,median,p25,p75}, reasoning (array), caveats (array), sources (array).`;

      const body = {
        contents: [{
          role: "user",
          parts: [
            { text: prompt },
            { text: "ITEM:" },               { text: JSON.stringify(item || {}) },
            { text: "COMPARABLE_LISTINGS:" },{ text: JSON.stringify(comps || []) },
            { text: "PUBLIC_SNIPPETS:" },    { text: JSON.stringify(webSnippets || []) }
          ]
        }],
        generationConfig: {
          temperature: 0.2, topP: 0.9, maxOutputTokens: 1024
        }
      };

      const resp = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });

      if (resp.ok) {
        const data = await resp.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
        try { aiJson = JSON.parse(text); } catch (_) { aiJson = null; }
      }
    }

    // Build final response with fallbacks
    let out = aiJson || {};
    if (!out.priceBands || !Number.isFinite(out.priceBands.suggested)) {
      // try compute from comps
      const bandsFromComps = computeBandsFromComps(comps);
      if (bandsFromComps) {
        out.priceBands = bandsFromComps;
        out.summary = out.summary || `Computed bands from ${comps.length} comparable listing(s).`;
      } else {
        // last resort: heuristic from user price
        if (Number(item.price)) {
          out.priceBands = heuristicBandsFromUser(item.price);
          out.summary = out.summary || "No comparable data available; used your entered price to estimate quick/suggested/patient bands.";
          out.caveats = out.caveats || [];
          out.caveats.push("Heuristic based on your entered price. Add comps or enable web snippets for better accuracy.");
        } else {
          out.summary = out.summary || "No structured AI output and no comparable listings available.";
          out.priceBands = out.priceBands || {};
        }
      }
    }

    // Always include minimal debug
    out.debug = {
      compsCount: comps?.length || 0,
      webSnippets: webSnippets?.length || 0,
      usedAI: !!aiJson
    };

    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ error: String(e?.message || e) }) };
  }
};
