// netlify/functions/price-advisor.js
// Node 18+ (Netlify default). No external deps needed.
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

/* ──────────────────────────────────────────────────────────────
 * Utilities
 * ────────────────────────────────────────────────────────────── */
const ok = (body, extraHeaders = {}) => ({
  statusCode: 200,
  headers: {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-gemini-key,x-gemini-model",
    ...extraHeaders
  },
  body: JSON.stringify(body)
});
const bad = (status, msg, extra = {}) => ({
  statusCode: status,
  headers: {
    "content-type": "application/json",
    "access-control-allow-origin": "*"
  },
  body: JSON.stringify({ ok: false, error: msg, ...extra })
});

// Extract JSON safely even if model wraps in backticks accidentally.
function extractJSON(text) {
  if (!text) return null;
  // fence block
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) {
    try { return JSON.parse(fence[1]); } catch {}
  }
  // first JSON object substring
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const slice = text.slice(start, end + 1);
    try { return JSON.parse(slice); } catch {}
  }
  // direct parse
  try { return JSON.parse(text); } catch {}
  return null;
}

// INR int normalize
function toInt(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.round(x) : null;
}
function clampRange(obj) {
  if (!obj) return {};
  const m = toInt(obj.min);
  const M = toInt(obj.max);
  if (m == null && M == null) return {};
  if (m != null && M != null && m > M) return { min: M, max: m };
  return { min: m ?? null, max: M ?? null };
}

/* ──────────────────────────────────────────────────────────────
 * Main handler
 * ────────────────────────────────────────────────────────────── */
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return ok({ ok: true });
  if (event.httpMethod !== 'POST') return bad(405, 'Use POST');

  const GEMINI = process.env.GEMINI_API_KEY || event.headers['x-gemini-key'];
  if (!GEMINI) return bad(400, 'GEMINI_API_KEY missing. Set env in Netlify or send x-gemini-key.');

  // Allow override, default to gemini-2.5-flash
  const MODEL = (event.headers['x-gemini-model'] || 'gemini-2.5-flash').trim();

  let p = {};
  try { p = JSON.parse(event.body || '{}'); } catch { return bad(400, 'Invalid JSON body'); }

  // Inputs (keep minimal & robust)
  const category    = (p.category || '').trim();
  const subCategory = (p.subCategory || '').trim();
  const brand       = (p.brand || '').trim();
  const model       = (p.model || '').trim();
  const title       = (p.title || '').trim();
  const descText    = (p.descriptionText || '').slice(0, 4000);
  const userPrice   = typeof p.userPrice === 'number' ? p.userPrice : null;

  const loc = p.location || {};
  const city  = (loc.city  || '').trim();
  const state = (loc.state || '').trim();
  const area  = (loc.area  || '').trim();

  const vehicle  = p.vehicle  || null; // for Cars/Bikes
  const property = p.property || null; // for Properties

  if (!category || !brand || !city) {
    return bad(400, 'Missing required fields: category, brand, city');
  }

  // Guidance for the model (concise and strict JSON contract)
  const system = [
    "You are a pricing analyst for India. Use Google Search grounding to fetch CURRENT web prices.",
    "1) DERIVE attributes from title/description if missing (e.g., age, battery health, box/bill, year, km, owners, area sqft, bhk, etc.).",
    "2) Use reputable Indian sources (brand store, Croma, Reliance Digital, Vijay Sales, Amazon India) for new prices.",
    "3) For used, prefer OLX, Quikr, Cashify, Cars24, Bikes24, refurbished stores in India.",
    "4) Normalize to INR integers. Provide realistic ranges (ignore extreme outliers).",
    "5) If attributes signal higher or lower price (e.g., battery health 90%, single-owner, high km), adjust ranges logically.",
    "6) OUTPUT STRICT JSON ONLY with keys: new_price_est, used_price_est, sources, notes, derived.",
    "Schema:",
    "{",
    '  "new_price_est": { "range_min": number|null, "range_max": number|null, "with_bank_offer_min": number|null },',
    '  "used_price_est": {',
    '     "excellent":   { "min": number|null, "max": number|null },',
    '     "good":        { "min": number|null, "max": number|null },',
    '     "refurbished": { "min": number|null, "max": number|null }',
    "  },",
    '  "sources": { "retail":[{"title":string,"url":string}], "used":[{"title":string,"url":string}] },',
    '  "notes": string,',
    '  "derived": { "condition":string|null, "age":string|null, "battery_health":string|null, "box_bill":string|null,',
    '               "warranty":string|null, "km":string|null, "year":string|null, "owners":string|null,',
    '               "area_sqft":string|null, "bhk":string|null, "city":string|null, "state":string|null, "model_resolved":string|null }',
    "}"
  ].join('\n');

  const facts = {
    category, subCategory, brand, model, title,
    descriptionText: descText,
    location: { area, city, state, country: "India" },
    vehicle, property
  };

  const userMsg = [
    "User listing facts. Fill gaps by deriving from title/description. Then search and estimate:",
    JSON.stringify(facts, null, 2)
  ].join('\n');

  const body = {
    // Prefer systemInstruction (camelCase) to avoid safety enum issues
    systemInstruction: { role: "system", parts: [{ text: system }] },

    contents: [
      { role: "user", parts: [{ text: userMsg }] }
    ],

    // Live search grounding
    tools: [{ googleSearchRetrieval: {} }],

    // Minimal generationConfig to avoid INVALID_ARGUMENT
    generationConfig: {
      temperature: 0.2,
      topP: 0.8,
      maxOutputTokens: 2048
      // responseMimeType: "application/json" // optional - omit to be safe
    }
    // NO safetySettings (avoid wrong enums)
  };

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=` + encodeURIComponent(GEMINI),
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), timeout: 30000 }
    );

    const raw = await resp.text();
    if (!resp.ok) {
      return bad(resp.status, raw || 'Gemini error');
    }

    let json;
    try { json = JSON.parse(raw); } catch (_) {
      return bad(502, 'Gemini response parse error', { raw });
    }

    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const data = extractJSON(text);
    if (!data) {
      return bad(502, 'Model did not return valid JSON', { text });
    }

    // Normalize response shape
    const newP = data.new_price_est || {};
    const used = data.used_price_est || {};
    const out = {
      new_price_est: {
        range_min: toInt(newP.range_min),
        range_max: toInt(newP.range_max),
        with_bank_offer_min: toInt(newP.with_bank_offer_min)
      },
      used_price_est: {
        excellent: clampRange(used.excellent),
        good:      clampRange(used.good),
        refurbished: clampRange(used.refurbished)
      },
      sources: {
        retail: Array.isArray(data?.sources?.retail) ? data.sources.retail.slice(0, 6) : [],
        used:   Array.isArray(data?.sources?.used)   ? data.sources.used.slice(0, 6)   : []
      },
      notes: (data.notes || '').toString().slice(0, 400),
      derived: data.derived || {}
    };

    if (userPrice != null && out.used_price_est.good?.min != null && out.used_price_est.good?.max != null) {
      const g = out.used_price_est.good;
      out.user_compare =
        (userPrice < g.min) ? "Your price seems lower than Good range." :
        (userPrice > g.max) ? "Your price seems higher than Good range." :
        "Your price is within Good range.";
    }

    return ok({ ok: true, data: out });
  } catch (e) {
    return bad(502, e.message || 'Backend failure');
  }
};
