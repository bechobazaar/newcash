// netlify/functions/price-advisor.js
// Node 18+ (Netlify)
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
  body: JSON.stringify({ ok:false, error: msg })
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return ok({ ok:true });
  if (event.httpMethod !== 'POST')  return bad(405, 'Use POST');

  const GEMINI = process.env.GEMINI_API_KEY;
  if (!GEMINI) return bad(400, 'GEMINI_API_KEY missing in env');

  let p={};
  try { p = JSON.parse(event.body||'{}'); } catch {}

  // User-filled structured bits
  const category    = p.category || '';
  const subCategory = p.subCategory || '';
  const brand       = p.brand || '';
  const model       = p.model || '';
  const title       = p.title || '';
  const descText    = (p.descriptionText || '').slice(0, 4000); // Quill plain text
  const userPrice   = typeof p.userPrice === 'number' ? p.userPrice : null;

  const loc = p.location || {};
  const city  = loc.city  || '';
  const state = loc.state || '';
  const area  = loc.area  || '';

  // Vehicles/Properties optional structured
  const vehicle  = p.vehicle  || null;
  const property = p.property || null;

  // Prompt: derive attributes from title/description; then search web; then JSON
  const system = [
    "You are a pricing analyst for India. Use Google Search grounding to fetch CURRENT web prices.",
    "Extract attributes from the user's title/description when missing.",
    "Return STRICT JSON only (no markdown). Keys:",
    " new_price_est: { range_min, range_max, with_bank_offer_min }",
    " used_price_est: { excellent:{min,max}, good:{min,max}, refurbished:{min,max} }",
    " sources: { retail:[{title,url}], used:[{title,url}] }  // <= 8 total links",
    " notes: string (<=60 words, India-specific)",
    " derived: { condition, age, battery_health, box_bill, warranty, km, year, owners, area_sqft, bhk, city, state, model_resolved }",
    "Rules:",
    "- Prefer reputable Indian retail (brand store, Croma, Reliance, Vijay Sales, etc.).",
    "- For used, prefer OLX/Quikr/Cashify etc. India.",
    "- Normalize to INR integers. Use realistic ranges (IQR).",
    "- If attributes found (e.g., battery health 90%, 1 year old, box/bill), bias the used range upward/downward accordingly.",
    "- For vehicles, use year/km/owners; for properties, consider area (₹/sqft) where available."
  ].join('\n');

  const facts = {
    category, subCategory, brand, model, title,
    descriptionText: descText,
    location: { area, city, state, country: "India" },
    vehicle, property
  };

  const user = [
    "User facts (use as hints, but also derive details from text):",
    JSON.stringify(facts, null, 2),
    "Return ONLY JSON with keys: new_price_est, used_price_est, sources, notes, derived"
  ].join('\n');

  const body = {
    contents: [
      { role: "user", parts: [{ text: system }] },
      { role: "user", parts: [{ text: user }] }
    ],
    tools: [{ googleSearchRetrieval: {} }],
    generationConfig: {
      temperature: 0.2,
      topP: 0.8,
      maxOutputTokens: 2048,
      response_mime_type: "application/json"
    },
    safetySettings: [
      { category:"HARM_CATEGORY_HATE_SPEECH", threshold:"BLOCK_NONE" },
      { category:"HARM_CATEGORY_HARASSMENT",  threshold:"BLOCK_NONE" },
      { category:"HARM_CATEGORY_SEXUAL",      threshold:"BLOCK_NONE" },
      { category:"HARM_CATEGORY_DANGEROUS",   threshold:"BLOCK_NONE" }
    ]
  };

  try {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key="+encodeURIComponent(GEMINI),
      { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(body), timeout: 30000 }
    );
    if (!r.ok) return bad(r.status, await r.text());
    const j = await r.json();

    const text = j?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    let data; try { data = JSON.parse(text); } catch { return bad(502, "Invalid JSON from model"); }

    const out = {
      new_price_est: data?.new_price_est || {},
      used_price_est: data?.used_price_est || {},
      sources: {
        retail: (data?.sources?.retail || []).slice(0,6),
        used:   (data?.sources?.used   || []).slice(0,6)
      },
      notes: data?.notes || "",
      derived: data?.derived || {}
    };

    if (userPrice && data?.used_price_est?.good?.min) {
      out.user_compare = userPrice < data.used_price_est.good.min
        ? "Your price seems lower than Good range."
        : (userPrice > data.used_price_est.good.max
            ? "Your price seems higher than Good range."
            : "Your price is within Good range.");
    }

    return ok({ ok:true, data: out });
  } catch (e) {
    return bad(502, e.message || "Backend failure");
  }
};
