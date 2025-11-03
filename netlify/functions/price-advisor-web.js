// netlify/functions/price-advisor-web.js
// Uses OpenAI Responses API with json_schema (correct param names)

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

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return ok("");
    if (event.httpMethod !== "POST") return bad(405, "POST only");

    const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
    const TAVILY_KEY = process.env.TAVILY_API_KEY || "";
    if (!OPENAI_KEY) return bad(400, "Missing OPENAI_API_KEY");

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

    // ── Optional Tavily web search ───────────────────────────────────────────
    let web = { used: false, answer: "", results: [] };
    if (TAVILY_KEY) {
      try {
        const tRes = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            api_key: TAVILY_KEY,
            query: `Used price and recent listing range for ${brand} ${model || category} in ${city}, ${state}, India.`,
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

    // ── System prompt + JSON schema ──────────────────────────────────────────
    const sys =
      "You are an Indian marketplace price advisor. Estimate used-market band and a realistic quick-sale price in INR. " +
      "Consider condition, storage/variant, bill/box, battery health (phones), and regional demand. " +
      "Return strictly the requested JSON schema. Also include a short HTML paragraph 'webview_summary_html' (2–4 sentences) " +
      "that reads like a web-browse result (bold model + city, market band, recommended ask, brief reasons). " +
      "If web_results exist, ground your paragraph and add 2–4 sources (title + url).";

    const jsonSchema = {
      name: "PriceAdvice",
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          market_price_low:  { type: "number" },
          market_price_high: { type: "number" },
          suggested_price:   { type: "number" },
          confidence:        { type: "string", enum: ["low", "medium", "high"] },
          old_vs_new: {
            type: "object",
            additionalProperties: false,
            properties: {
              launch_mrp:   { type: "number" },
              typical_used: { type: "number" }
            }
          },
          why: { type: "string" },
          webview_summary_html: { type: "string" },
          sources: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                title: { type: "string" },
                url:   { type: "string" }
              }
            }
          }
        },
        required: ["market_price_low", "market_price_high", "suggested_price", "confidence"]
      },
      strict: true
    };

    const topSources = (web.results || []).slice(0, 4).map(r => ({ title: r.title, url: r.url }));
    const userCtx = {
      category, brand, model,
      region: [city, state].filter(Boolean).join(", "),
      input_price: price,
      web_used: web.used,
      web_answer: web.answer,
      web_results: web.results,
      top_sources: topSources
    };

    // plan → model
    const plan = (event.headers["x-plan"] || event.headers["X-Plan"] || "free").toString().toLowerCase();
    const modelName = plan === "pro" ? "gpt-5-mini" : "gpt-4o-mini";

    // ── ✅ OpenAI Responses API (correct payload) ────────────────────────────
    const aiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: modelName,
        input: [
          { role: "system", content: [{ type: "input_text", text: sys }] },
          { role: "user",   content: [{ type: "input_text", text: JSON.stringify({ task: "estimate_used_price_india", user_input: userCtx }) }] }
        ],
        response_format: { type: "json_schema", json_schema: jsonSchema },
        max_output_tokens: 900
      })
    });

    if (!aiRes.ok) {
      return bad(400, `OpenAI error: ${await aiRes.text()}`);
    }

    const aiJson = await aiRes.json();
    const raw = aiJson?.output_text || "";
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch {}

    // ── Post-fixes / safety ──────────────────────────────────────────────────
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

    const result = ensureBand({
      ...parsed,
      webview_summary_html: safeSummary(parsed?.webview_summary_html),
      sources: Array.isArray(parsed?.sources) ? parsed.sources.slice(0, 4) : topSources
    });

    return ok({ ok: true, provider: "openai", model: modelName, result });
  } catch (e) {
    return bad(400, String(e?.message || e));
  }
};
