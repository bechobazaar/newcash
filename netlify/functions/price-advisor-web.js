// netlify/functions/price-advisor-web.js
// Works without response_format; parses JSON from model text output.

const ok = (body, headers = {}) => ({
  statusCode: 200,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, X-Plan",
    "access-control-max-age": "600",
    "vary": "Origin",
    ...headers,
  },
  body: JSON.stringify(body),
});

const bad = (statusCode, msg) => ({
  statusCode,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, X-Plan",
    "access-control-max-age": "600",
    "vary": "Origin",
  },
  body: JSON.stringify({ error: msg }),
});

// naive JSON extractor from a text blob
function extractJsonBlock(s = "") {
  // Try the whole string first
  try { return JSON.parse(s); } catch {}
  // Then try the largest {...} block
  const m = s.match(/\{[\s\S]*\}$/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  // Then try any JSON-looking block
  const all = s.match(/\{[\s\S]*?\}/g) || [];
  for (const cand of all) {
    try { return JSON.parse(cand); } catch {}
  }
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return ok("");
  if (event.httpMethod !== "POST") return bad(405, "POST only");

  const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
  const TAVILY_KEY = process.env.TAVILY_API_KEY || ""; // optional
  if (!OPENAI_KEY) return bad(400, "Missing OPENAI_API_KEY");

  try {
    const { input = {} } = JSON.parse(event.body || "{}");
    const category = (input.category || "").trim();
    const brand    = (input.brand || "").trim();
    const model    = (input.model || "").trim();
    const city     = (input.city || "").trim();
    const state    = (input.state || "").trim();
    const price    = Number(input.price || 0) || 0;

    if (!category || !brand || !city || !state) {
      return bad(400, "Missing required fields (category, brand, city, state)");
    }

    // ── Optional web grounding via Tavily ─────────────────────────────
    let web = { used: false, answer: "", results: [] };
    if (TAVILY_KEY) {
      try {
        const tRes = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            api_key: TAVILY_KEY,
            query: `Used price and recent listings for ${brand} ${model || category} in ${city}, ${state}, India.`,
            search_depth: "advanced",
            max_results: 8,
            include_answer: true,
            days: 365,
            include_images: false,
            include_raw_content: false,
          }),
        });
        const tJson = await tRes.json();
        web.used = true;
        web.answer = tJson?.answer || "";
        web.results = Array.isArray(tJson?.results)
          ? tJson.results.slice(0, 6).map(r => ({
              title: r.title || "",
              url: r.url || "",
              content: r.content || "",
            }))
          : [];
      } catch { /* ignore */ }
    }

    const topSources = (web.results || []).slice(0, 4).map(r => ({ title: r.title, url: r.url }));

    const instructions =
`Return ONLY JSON. No prose, no code fences.
Schema:
{
  "market_price_low": number,
  "market_price_high": number,
  "suggested_price": number,
  "confidence": "low" | "medium" | "high",
  "old_vs_new": { "launch_mrp"?: number, "typical_used"?: number },
  "why"?: string,
  "webview_summary_html"?: string,
  "sources"?: [{ "title": string, "url": string }]
}

You are an Indian marketplace price advisor. Estimate a used-market band and a realistic quick-sale price in INR (plain numbers).
Consider condition, storage/variant, bill/box availability, battery health for phones, and local demand.
Write 'webview_summary_html' as a short 2–4 sentence HTML paragraph like a web-browse result: start with bold model + city, state, then market range + recommended ask + brief reasons.
If web_results are present, ground the paragraph to them and include 2–4 sources (title + url). If none, keep sources empty.`;

    const userCtx = {
      category,
      brand,
      model,
      region: [city, state].filter(Boolean).join(", "),
      input_price: price,
      web_used: web.used,
      web_answer: web.answer,
      web_results: web.results,
      top_sources: topSources,
    };

    const plan = (event.headers["x-plan"] || event.headers["X-Plan"] || "free").toString().toLowerCase();
    const modelName = plan === "pro" ? "gpt-5-mini" : "gpt-4o-mini";

    // Keep payload minimal for widest compatibility
    const payload = {
      model: modelName,
      instructions,
      input: JSON.stringify(userCtx),
      max_output_tokens: 900,
      // temperature left default
    };

    const aiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    if (!aiRes.ok) {
      const txt = await aiRes.text();
      return bad(400, `OpenAI error: ${txt}`);
    }

    const aiJson = await aiRes.json();
    const raw = aiJson?.output_text || "";
    let parsed = extractJsonBlock(raw) || {};

    // ── Post-fixes / sanity guards ───────────────────────────────────
    const ensureBand = (obj) => {
      let lo = Number(obj.market_price_low || 0);
      let hi = Number(obj.market_price_high || 0);
      let sg = Number(obj.suggested_price || 0);

      if (!Number.isFinite(lo) || lo <= 0) lo = Math.max(1, Math.round((price || 0) * 0.7) || 1000);
      if (!Number.isFinite(hi) || hi <= 0) hi = Math.max(lo + 1, Math.round((price || 0) * 1.3) || lo + 500);
      if (hi < lo) [lo, hi] = [hi, lo];
      if (!Number.isFinite(sg) || sg <= 0) sg = Math.round(lo * 0.4 + hi * 0.6);

      return { ...obj, market_price_low: lo, market_price_high: hi, suggested_price: sg };
    };

    const safeSummary = (s) =>
      typeof s === "string" && s.trim()
        ? s.trim()
        : `<p><b>${brand} ${model || category}, ${city}:</b> Pricing estimated from typical India used-market trends for this category and region. List near the mid of the range for a faster sale.</p>`;

    // adopt sources if present, else use Tavily topSources
    const finalSources = Array.isArray(parsed?.sources) && parsed.sources.length
      ? parsed.sources.slice(0, 4)
      : topSources;

    const result = ensureBand({
      ...parsed,
      webview_summary_html: safeSummary(parsed?.webview_summary_html),
      sources: finalSources,
      confidence: (parsed?.confidence || "medium"),
    });

    return ok({ ok: true, provider: "openai", model: modelName, result });
  } catch (e) {
    return bad(400, String(e?.message || e));
  }
};
