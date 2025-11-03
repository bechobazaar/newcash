// netlify/functions/price-advisor-web.js

const CORS = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, X-Plan",
  "access-control-max-age": "86400",
  "vary": "Origin",
};

const ok = (body, extra = {}) => ({
  statusCode: 200,
  headers: { ...CORS, ...extra },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const bad = (code, msg) => ({
  statusCode: code,
  headers: CORS,
  body: JSON.stringify({ error: msg }),
});

const withTimeout = (p, ms = 25000, label = "request") => {
  let t;
  const timeout = new Promise((_, rej) =>
    (t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms))
  );
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };
  if (event.httpMethod !== "POST") return bad(405, "POST only");

  const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
  const TAVILY_KEY = process.env.TAVILY_API_KEY || "";
  if (!OPENAI_KEY) return bad(400, "Server missing OPENAI_API_KEY");

  try {
    const { input = {} } = JSON.parse(event.body || "{}");
    const category = (input.category || "").trim();
    const brand = (input.brand || "").trim();
    const deviceModel = (input.model || "").trim();
    const city = (input.city || "").trim();
    const state = (input.state || "").trim();
    const price = Number(input.price || 0) || 0;

    if (!category || !brand || !city || !state) {
      return bad(400, "Missing required fields (category, brand, city, state)");
    }

    // ---------- Tavily (optional web grounding) ----------
    let web = { used: false, answer: "", results: [] };
    if (TAVILY_KEY) {
      try {
        const q1 = `${brand} ${deviceModel || category} used price ${city} ${state} India`;
        const q2 = `${brand} ${deviceModel || category} resale price India`;

        const tRes = await withTimeout(
          fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              api_key: TAVILY_KEY,
              query: `Find recent used-market prices and listing ranges for ${brand} ${deviceModel || category} in ${city}, ${state}, India.`,
              search_depth: "advanced",
              max_results: 8,
              include_answer: true,
              topic: "general",
              days: 365,
              include_images: false,
              include_raw_content: false,
              follow_up_questions: [q1, q2],
            }),
          }),
          15000,
          "tavily"
        );

        if (tRes.ok) {
          const tJson = await tRes.json();
          web.used = true;
          web.answer = tJson?.answer || "";
          web.results = Array.isArray(tJson?.results)
            ? tJson.results.slice(0, 6).map((r) => ({
                title: r.title || "",
                url: r.url || "",
                content: r.content || "",
              }))
            : [];
        }
      } catch {}
    }

    // ---------- Prompt + JSON schema ----------
    const sys = [
      "You are an Indian marketplace price advisor.",
      "Estimate a used-market band and a realistic quick-sale price for the item in the user's city/region.",
      "All prices in INR as numbers (no commas).",
      "Consider condition, storage/variant, bill/box availability, battery health for phones, and location demand.",
      "Return strictly the requested JSON schema.",
      "Also produce a short HTML paragraph named webview_summary_html (2–4 sentences) that reads like a web-browse result:",
      "start with bold model + city, summarize current market range and a recommended ask price, and mention key factors briefly.",
      "If web_results exist, ground your paragraph and add 2–4 sources (title + url). If no web data, still write a helpful paragraph and keep sources empty.",
    ].join(" ");

    const jsonSchema = {
      name: "PriceAdvice",
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          market_price_low: { type: "number" },
          market_price_high: { type: "number" },
          suggested_price: { type: "number" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          old_vs_new: {
            type: "object",
            additionalProperties: false,
            properties: {
              launch_mrp: { type: "number" },
              typical_used: { type: "number" },
            },
          },
          why: { type: "string" },
          webview_summary_html: { type: "string" },
          sources: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: { title: { type: "string" }, url: { type: "string" } },
            },
          },
        },
        required: ["market_price_low", "market_price_high", "suggested_price", "confidence"],
      },
      strict: true,
    };

    const topSources = (web.results || []).slice(0, 4).map((r) => ({ title: r.title, url: r.url }));
    const userCtx = {
      category,
      brand,
      model: deviceModel,
      region: [city, state].filter(Boolean).join(", "),
      input_price: price,
      web_used: web.used,
      web_answer: web.answer,
      web_results: web.results,
      top_sources: topSources,
    };

    const plan =
      (event.headers["x-plan"] || event.headers["X-Plan"] || "free").toString().toLowerCase();
    const aiModel = plan === "pro" ? "gpt-5-mini" : "gpt-4o-mini";

    // ---------- Call OpenAI — try JSON schema first ----------
    async function callOpenAI(payload) {
      const r = await withTimeout(
        fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${OPENAI_KEY}`,
          },
          body: JSON.stringify(payload),
        }),
        25000,
        "openai"
      );
      if (!r.ok) {
        const txt = await r.text();
        throw new Error(txt);
      }
      return r.json();
    }

    let aiJson, raw;
    try {
      aiJson = await callOpenAI({
        model: aiModel,
        input: [
          { role: "system", content: [{ type: "text", text: sys }] },
          { role: "user", content: [{ type: "text", text: JSON.stringify({ task: "estimate_used_price_india", user_input: userCtx }) }] },
        ],
        max_output_tokens: 900,
        // ✅ correct key for schema:
        response_format: { type: "json_schema", json_schema: jsonSchema },
      });
      raw = aiJson?.output_text || "";
    } catch (e) {
      // If server says unknown/unsupported parameter, retry without schema and parse manually
      const msg = String(e.message || e);
      const looksLikeSchemaUnsupported =
        /response_format|Unknown parameter|unsupported/i.test(msg);
      if (!looksLikeSchemaUnsupported) throw new Error(`OpenAI error: ${msg}`);

      const aiJson2 = await callOpenAI({
        model: aiModel,
        input: [
          { role: "system", content: [{ type: "text", text: sys }] },
          { role: "user", content: [{ type: "text", text: JSON.stringify({ task: "estimate_used_price_india", user_input: userCtx }) }] },
        ],
        max_output_tokens: 900,
      });
      raw = aiJson2?.output_text || "";
    }

    let parsed = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      // crude extraction fallback: find first {...} and parse
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch {}
      }
    }

    // ---------- Sanity guards ----------
    const ensureBand = (obj) => {
      let lo = Number(obj.market_price_low || 0);
      let hi = Number(obj.market_price_high || 0);
      let sg = Number(obj.suggested_price || 0);
      if (!Number.isFinite(lo) || lo <= 0) lo = Math.max(1, Math.round(price * 0.7));
      if (!Number.isFinite(hi) || hi <= 0) hi = Math.max(lo + 1, Math.round(price * 1.3));
      if (hi < lo) [lo, hi] = [hi, lo];
      if (!Number.isFinite(sg) || sg <= 0) sg = Math.round(lo * 0.4 + hi * 0.6);
      return { ...obj, market_price_low: lo, market_price_high: hi, suggested_price: sg };
    };

    const safeSummary = (s) =>
      typeof s === "string" && s.trim()
        ? s.trim()
        : `<p><b>${brand} ${deviceModel || category}, ${city}:</b> Limited public data found. Pricing is estimated from typical India used-market trends for this category and region. Choose an ask price near the mid of the range for a faster sale.</p>`;

    const result = ensureBand({
      ...parsed,
      webview_summary_html: safeSummary(parsed?.webview_summary_html),
      sources: Array.isArray(parsed?.sources) ? parsed.sources.slice(0, 4) : topSources,
    });

    return ok({ ok: true, provider: "openai", model: aiModel, result });
  } catch (e) {
    return bad(400, `OpenAI error: ${String(e.message || e)}`);
  }
};
