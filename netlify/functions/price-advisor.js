// netlify/functions/price-advisor.js
// Node 18+ (Netlify default)
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

const ok = (body) => ({
  statusCode: 200,
  headers: {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST,OPTIONS",
    "access-control-allow-headers": "content-type"
  },
  body: JSON.stringify(body)
});
const bad = (status, msg) => ({
  statusCode: status,
  headers: {
    "content-type": "application/json",
    "access-control-allow-origin": "*"
  },
  body: JSON.stringify({ ok: false, error: msg })
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return ok({ ok: true });
  if (event.httpMethod !== 'POST')  return bad(405, 'Use POST');

  const GEMINI = process.env.GEMINI_API_KEY;
  if (!GEMINI) return bad(400, 'GEMINI_API_KEY missing in env.');

  let payload = {};
  try { payload = JSON.parse(event.body || '{}'); } catch { payload = {}; }

  const {
    category='', subCategory='', brand='', model='',
    condition='', title='',
    location={}, vehicle=null, property=null,
    userPrice=null, explain=false
  } = payload || {};
  const { area='', city='', state='' } = location || {};

  // Build a concise fact sheet for the model
  const facts = {
    category, subCategory, brand, model, condition, title,
    location: { area, city, state, country: 'India' },
    vehicle: (category==='Cars'||category==='Bikes') ? vehicle : null,
    property: (category==='Properties') ? property : null,
    userPrice
  };

  // Ask Gemini with Google Search grounding & JSON response
  const system = [
    "You are a pricing analyst for used & new items in India.",
    "Search the live web with Google Search grounding and aggregate prices.",
    "Return STRICT JSON only (no markdown).",
    "Target outputs:",
    "- new_price_est: {range_min, range_max, with_bank_offer_min}",
    "- used_price_est: {excellent:{min,max}, good:{min,max}, refurbished:{min,max}}",
    "- sources: {retail:[{title,url}], used:[{title,url}]} (max 8 combined)",
    "- notes: <=60 words, India-specific and neutral.",
    "Pricing rules:",
    "- Use reputable Indian sources for retail (brand store, Croma, Reliance, Vijay Sales, etc.).",
    "- For used, prefer OLX/Quikr/Cashify and similar India platforms.",
    "- Normalize to INR and numeric integers.",
    "- For properties, consider area (sqft) if given; for vehicles, weight KM/year/ownership.",
    "- If data is thin, widen search to broader India context but stay realistic.",
    "Always fill numeric fields when possible; otherwise omit the field."
  ].join('\n');

  const user = [
    "Build price suggestions from the following user-filled facts:",
    JSON.stringify(facts, null, 2),
    "Return only JSON with keys: new_price_est, used_price_est, sources, notes."
  ].join('\n');

  const body = {
    contents: [
      { role: "user", parts: [{ text: system }] },
      { role: "user", parts: [{ text: user }] }
    ],
    tools: [{ googleSearchRetrieval: {} }],     // ← live web grounding
    generationConfig: {
      temperature: 0.2,
      topP: 0.8,
      maxOutputTokens: 2048,
      response_mime_type: "application/json"
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HARASSMENT",  threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUAL",      threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS",   threshold: "BLOCK_NONE" }
    ]
  };

  try {
    const resp = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + encodeURIComponent(GEMINI),
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), timeout: 30000 }
    );
    if (!resp.ok) {
      const t = await resp.text();
      return bad(resp.status, `Gemini error: ${t || resp.statusText}`);
    }
    const j = await resp.json();

    // Parse JSON string from the first candidate
    const text = j?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    let data;
    try { data = JSON.parse(text); }
    catch { return bad(502, "Model did not return valid JSON."); }

    // Normalize structure + guard
    const out = {
      new_price_est: data?.new_price_est || {},
      used_price_est: data?.used_price_est || {},
      sources: {
        retail: (data?.sources?.retail || []).slice(0, 6),
        used:   (data?.sources?.used   || []).slice(0, 6)
      },
      notes: data?.notes || ""
    };

    // (Optional) append tiny compare line if user price present
    if (typeof userPrice === 'number' && data?.used_price_est?.good?.min) {
      out.user_compare = userPrice < data.used_price_est.good.min
        ? "Your price seems lower than typical Good range."
        : (userPrice > data.used_price_est.good.max
          ? "Your price seems higher than typical Good range."
          : "Your price lies within typical Good range.");
    }

    return ok({ ok: true, data: out });
  } catch (e) {
    return bad(502, e.message || "Backend failure");
  }
};
