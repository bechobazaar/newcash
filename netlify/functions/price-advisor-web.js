// netlify/functions/price-advisor-web.js
// Node 18+ (Netlify). Dynamic import for node-fetch.
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

/* ─────────────────────────────────────────
   Small utilities
─────────────────────────────────────────── */
const ok = (body, event) => ({
  statusCode: 200,
  headers: cors(event),
  body: JSON.stringify(body),
});
const err = (code, body, event) => ({
  statusCode: code,
  headers: cors(event),
  body: JSON.stringify(body),
});

function cors(event) {
  const origin = event?.headers?.origin || event?.headers?.Origin || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Access-Control-Allow-Headers': 'Content-Type, X-Plan, X-OpenAI-Model',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'Content-Type': 'application/json; charset=utf-8',
  };
}
function safeParseJSON(s) { try { return JSON.parse(s); } catch { return null; } }
function num(n, def = 0) { const x = Number(n); return Number.isFinite(x) ? x : def; }
function clip(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
function roundInt(n) { return Math.round(Number(n) || 0); }
function fmtINR(n) {
  const s = Math.round(Number(n) || 0).toString();
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const other = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return other + ',' + last3;
}

/* ─────────────────────────────────────────
   Input normalization
─────────────────────────────────────────── */
function normalizeInput(raw = {}) {
  const clean = (v) => (v == null ? '' : String(v).toString().trim());
  const out = {
    brand: clean(raw.brand),
    model: clean(raw.model),
    category: clean(raw.category),
    subCategory: clean(raw.subCategory),
    title: clean(raw.title),
    desc: clean(raw.desc),
    state: clean(raw.state),
    city: clean(raw.city),
    area: clean(raw.area),
    price: num(raw.price, 0),
    condition: clean(raw.condition),    // may be auto-extracted on client
    billBox: !!raw.billBox,
    age: clean(raw.age || raw.ageOrYear),
    kmDriven: clean(raw.kmDriven),
  };
  if (out.price < 0) out.price = 0;
  if (out.price > 2e8) out.price = 2e8;
  return out;
}

/* ─────────────────────────────────────────
   Heuristic fallback (when OpenAI fails)
─────────────────────────────────────────── */
function fallbackHeuristic(i = {}) {
  // Baseline MRP guess
  let baseMrp = 100000;
  const key = `${i.brand || ''} ${i.model || ''}`.toLowerCase();
  if (key.includes('s24') && key.includes('ultra')) baseMrp = 88000;
  if (key.includes('iphone 15')) baseMrp = 70000;

  // condition factor
  const c = (i.condition || '').toLowerCase();
  let factor = 0.70;
  if (/new|sealed/.test(c)) factor = 1.00;
  else if (/like new|excellent|mint|scratchless/.test(c)) factor = 0.85;
  else if (/very good/.test(c)) factor = 0.78;
  else if (/good/.test(c)) factor = 0.70;
  else if (/fair|used/.test(c)) factor = 0.60;
  else if (/poor|broken|crack|damaged/.test(c)) factor = 0.45;

  // age factor (~1.5%/month decay up to 24m)
  let ageFactor = 1.0;
  const m = i.age && i.age.match(/(\d+)\s*(month|months|yr|year|years?)/i);
  if (m) {
    const n = Number(m[1] || 0);
    const months = /month/.test(m[2]) ? n : n * 12;
    ageFactor = clip(1 - 0.015 * clip(months, 0, 24), 0.6, 1.0);
  }

  // very light metro uplift (for like-new phones etc.)
  const metro = /mumbai|delhi|new delhi|bengaluru|bangalore|hyderabad|pune|chennai|kolkata/i.test(i.city || '')
    ? 1.02 : 1.0;

  // bill/box small premium
  const bb = i.billBox ? 1.02 : 1.0;

  let mid = Math.round(baseMrp * factor * ageFactor * bb * metro);

  // crude vehicle wear if kmDriven present
  const kms = Number(String(i.kmDriven || '').replace(/[^\d.]/g, '')) || 0;
  if (/car|bike|scooter|motorcycle|vehicle/i.test(`${i.category} ${i.subCategory}`)) {
    const wear = 1 - clip(kms / 100000, 0, 0.35); // up to -35% at 100k km
    mid = Math.max(1000, Math.round(mid * wear));
  }

  const low = Math.round(mid * 0.92);
  const high = Math.round(mid * 1.08);
  const suggest = Math.round((low + high) / 2);
  const quick = Math.round(low * 0.98);
  const patience = Math.round(high * 1.07);

  return ensureBandShape({
    refs: {
      launch: `Approx new/launch reference around ₹${fmtINR(baseMrp)} for this variant (estimated).`,
      used: `Used market (heuristic): like-new items often listed in ₹${fmtINR(low)}–₹${fmtINR(high)} range.`,
    },
    band: { low, high, suggest, quick, patience },
  });
}

/* ─────────────────────────────────────────
   Coerce OpenAI outputs → final shape
─────────────────────────────────────────── */
function ensureBandShape(obj) {
  if (!obj || !obj.band) return null;
  let { low, high, suggest, quick, patience } = obj.band;

  low = roundInt(low);
  high = roundInt(high);
  if (!(low > 0 && high > 0)) return null;
  if (high < low) [low, high] = [high, low];

  // compute missing suggest
  if (!(suggest > 0)) suggest = roundInt((low + high) / 2);

  // compute quick/patience if missing
  if (!(quick > 0)) quick = roundInt(low * 0.97);
  if (!(patience > 0)) patience = roundInt(high * 1.07);

  // enforce order & spacing
  quick = Math.min(quick, low - 1);
  suggest = clip(suggest, low, high);
  patience = Math.max(patience, high + 1);

  return {
    refs: {
      launch: (obj.refs && obj.refs.launch) || '',
      used: (obj.refs && obj.refs.used) || '',
    },
    band: { low, high, suggest, quick, patience },
  };
}

function coerceOpenAIToBand(json) {
  if (!json || typeof json !== 'object') return null;
  const bandSrc = json.band || json.priceBand || {};
  let out = {
    refs: {
      launch: (json.refs && json.refs.launch) || json.launchRef || '',
      used: (json.refs && json.refs.used) || json.usedRef || '',
    },
    band: {
      low: num(bandSrc.low),
      high: num(bandSrc.high),
      suggest: num(bandSrc.suggest || bandSrc.avg || Math.round((num(bandSrc.low) + num(bandSrc.high)) / 2)),
      quick: num(bandSrc.quick),
      patience: num(bandSrc.patience),
    },
  };

  // If missing low/high but text exists, attempt parse from text
  if ((!out.band.low || !out.band.high) && (json.html || json.text || json.markdown)) {
    const s = String(json.html || json.text || json.markdown);
    const m = s.match(/₹?\s?([\d,]+)\s*(?:to|-|–)\s*₹?\s?([\d,]+)/i);
    if (m) {
      const low = Number(m[1].replace(/,/g, ''));
      const high = Number(m[2].replace(/,/g, ''));
      if (Number.isFinite(low) && Number.isFinite(high)) {
        out.band.low = low;
        out.band.high = high;
        out.band.suggest = out.band.suggest || Math.round((low + high) / 2);
      }
    }
  }

  return ensureBandShape(out);
}

/* ─────────────────────────────────────────
   Main handler
─────────────────────────────────────────── */
exports.handler = async (event) => {
  // Preflight + health
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors(event), body: '' };
  if (event.httpMethod === 'GET') return ok({ ok: true, name: 'price-advisor-web' }, event);

  try {
    const body = safeParseJSON(event.body || '{}') || {};
    const inputRaw = body.input;
    if (!inputRaw) return err(400, { error: 'missing input' }, event);

    const input = normalizeInput(inputRaw);

    // ── Improved, styled, stricter prompt ───────────────────────────────
    const prompt = `
🎯 ROLE: You are a no-nonsense Pricing Advisor for Indian C2C classifieds (OLX-style).
Return STRICT JSON ONLY matching the schema below. No markdown, no extra keys.

📦 INPUTS
brand=${input.brand}
model=${input.model}
category=${input.category}
subCategory=${input.subCategory}
condition=${input.condition}
billBox=${input.billBox}
age=${input.age}
kmDriven=${input.kmDriven}
city=${input.city}
state=${input.state}
userPrice=${input.price}

🧩 TASK
Estimate a realistic used-market price band in India right now, using common Indian listing patterns.
Keep it short, factual, and conservative (avoid hype). If info is thin, infer typical patterns sensibly.

📐 RULES (follow exactly)
1) Output only this JSON shape:
{
  "refs": {
    "launch": "string (<=100 chars, 1 line)",
    "used": "string (<=100 chars, 1 line)"
  },
  "band": {
    "low": number,        // INR integer
    "high": number,       // INR integer
    "suggest": number,    // INR integer, in [low..high]
    "quick": number,      // INR integer, ~2–5% below low (fast sale)
    "patience": number    // INR integer, ~5–10% above high (patient seller)
  }
}
— Do not include commas in numbers.
— Ensure: 0 < low ≤ suggest ≤ high < patience, and quick < low.
— Round all numbers to nearest integer rupees.

2) Calibrate by:
   • Condition: new > like-new > very good > good > fair > poor/broken.
   • Age: decay ~1–2% per month up to 24 months (cap total decay at ~40%).
   • billBox=true → small premium (~1–3%).
   • Vehicles: use kmDriven as wear factor (more km → lower).
   • City: metro (Mumbai/Delhi/Bengaluru/Hyderabad/Pune/Chennai/Kolkata) can be ±2–3% vs tier-2.
   • userPrice is not the answer; only a signal of seller expectation.

3) “refs” style:
   • launch: single line hint of new/launch MRP for that variant (approx if needed).
   • used: single line hint of typical used-market span like “₹X–₹Y (like-new/good)”.

4) If uncertain, stay conservative; never output extreme or implausible bands.

5) NEVER output text outside the JSON. No code fences, no commentary.

🚀 PRODUCE THE JSON NOW.
`.trim();

    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    const MODEL_PRIMARY = event.headers['x-openai-model'] || 'gpt-4.1-mini';
    const WANT_DEBUG = String(event.headers?.['x-plan'] || '').toLowerCase() === 'debug';

    if (!OPENAI_KEY) {
      const fb = fallbackHeuristic(input);
      fb.warning = 'OPENAI_API_KEY missing → heuristic';
      return ok(WANT_DEBUG ? { input, heuristic: fb } : fb, event);
    }

    // ===== OpenAI call (Responses → plain string JSON mode) with Chat fallback
    async function callOpenAIResponses(promptStr, signal) {
      const r = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${OPENAI_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL_PRIMARY,
          input: promptStr,                 // IMPORTANT: a plain string
          response_format: { type: 'json_object' },
          temperature: 0.2,
        }),
        signal,
      });

      if (!r.ok) {
        const text = await r.text().catch(()=>'');
        const errx = new Error('responses_api_error');
        errx.payload = text;
        throw errx;
      }

      const data = await r.json();
      return (
        safeParseJSON(data.output_text) ||
        safeParseJSON(data?.output?.[0]?.content?.[0]?.text) ||
        (typeof data === 'object' && data.json ? data.json : null)
      );
    }

    async function callOpenAIChat(promptStr, signal) {
      const chatModel = 'gpt-4o-mini';
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${OPENAI_KEY}`,
        },
        body: JSON.stringify({
          model: chatModel,
          response_format: { type: 'json_object' },
          temperature: 0.2,
          messages: [
            { role: 'system', content: 'Return JSON only. No markdown.' },
            { role: 'user', content: promptStr },
          ],
        }),
        signal,
      });

      if (!r.ok) {
        const text = await r.text().catch(()=>'');
        const errx = new Error('chat_api_error');
        errx.payload = text;
        throw errx;
      }

      const data = await r.json();
      const txt = data.choices?.[0]?.message?.content || '';
      return safeParseJSON(txt);
    }

    // Timeout + fallbacks
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 16000);
    let aiRaw = null;

    try {
      aiRaw = await callOpenAIResponses(prompt, ctrl.signal);
    } catch (e1) {
      try {
        aiRaw = await callOpenAIChat(prompt, ctrl.signal);
      } catch (e2) {
        const fb = fallbackHeuristic(input);
        fb.error = 'OpenAI error';
        fb.detail = (e1 && e1.payload ? e1.payload : String(e1)).slice(0, 900);
        clearTimeout(to);
        // Try coercing if aiRaw has something, else fallback object
        const co = coerceOpenAIToBand(aiRaw) || fb;
        return ok(WANT_DEBUG ? { input, prompt, aiRaw, final: co } : co, event);
      }
    } finally {
      clearTimeout(to);
    }

    // Coerce to final shape or fallback
    let final = coerceOpenAIToBand(aiRaw) || coerceOpenAIToBand({ json: aiRaw });
    if (!final) {
      const fb = fallbackHeuristic(input);
      fb.warning = 'AI parse fallback';
      return ok(WANT_DEBUG ? { input, prompt, aiRaw, final: fb } : fb, event);
    }

    // Sanity clamp
    const { low: L, high: H } = final.band;
    if (!(L > 0 && H > 0 && H >= L)) {
      const fb = fallbackHeuristic(input);
      fb.warning = 'AI invalid band → heuristic';
      return ok(WANT_DEBUG ? { input, prompt, aiRaw, final: fb } : fb, event);
    }

    // Optionally attach echo for debugging
    const payload = WANT_DEBUG ? { input, prompt, aiRaw, final } : final;
    return ok(payload, event);
  } catch (e) {
    const input = (() => {
      try { return normalizeInput((safeParseJSON(event.body || '{}') || {}).input); } catch { return {}; }
    })();
    const fb = fallbackHeuristic(input || {});
    fb.error = String(e && e.message ? e.message : e);
    return ok(fb, event);
  }
};
