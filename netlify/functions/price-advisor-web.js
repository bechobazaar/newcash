// netlify/functions/price-advisor-web.js
// Node 18+ (Netlify). Dynamic import for node-fetch.
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

/* ─────────────────────────────────────────
   Allowlist CORS (bechobazaar.com / *.netlify.app / localhost)
─────────────────────────────────────────── */
const ORIGIN_ALLOWLIST = [
  'https://bechobazaar.com',
  'https://www.bechobazaar.com',
  'https://bechobazaar.netlify.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];
function pickOrigin(event) {
  const o = event?.headers?.origin || event?.headers?.Origin || '';
  if (!o) return '*'; // no origin (curl / server -> allow)
  try {
    const u = new URL(o);
    const host = u.hostname;
    // allow any subdomain of netlify.app that is ours
    if (host.endsWith('.netlify.app')) return o;
    if (ORIGIN_ALLOWLIST.includes(o)) return o;
  } catch {}
  // Fallback: echo origin so browser accepts it (only if present)
  return o || '*';
}
function cors(event) {
  const origin = pickOrigin(event);
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Access-Control-Allow-Headers': 'Content-Type, X-Plan, X-OpenAI-Model',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'Content-Type': 'application/json; charset=utf-8',
  };
}

/* ─────────────────────────────────────────
   Small utilities
─────────────────────────────────────────── */
const ok = (body, event) => ({ statusCode: 200, headers: cors(event), body: JSON.stringify(body) });
const err = (code, body, event) => ({ statusCode: code, headers: cors(event), body: JSON.stringify(body) });
function safeParseJSON(s) { try { return JSON.parse(s); } catch { return null; } }
function num(n, def = 0) { const x = Number(n); return Number.isFinite(x) ? x : def; }
function clip(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
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
    condition: clean(raw.condition),
    billBox: !!raw.billBox,
    age: clean(raw.age || raw.ageOrYear),
    kmDriven: clean(raw.kmDriven),
    // vehicle extras (optional, helps context)
    yearOfPurchase: clean(raw.yearOfPurchase),
    tyreCondition: clean(raw.tyreCondition),
    accidentStatus: clean(raw.accidentStatus),
    allPapersAvailable: clean(raw.allPapersAvailable),
    pollutionExpiry: clean(raw.pollutionExpiry),
    taxExpiry: clean(raw.taxExpiry),
    insuranceExpiry: clean(raw.insuranceExpiry),
    ownership: clean(raw.ownership),
  };
  if (out.price < 0) out.price = 0;
  if (out.price > 2e8) out.price = 2e8;
  return out;
}

/* ─────────────────────────────────────────
   Heuristic fallback (when OpenAI fails)
─────────────────────────────────────────── */
function fallbackHeuristic(i = {}) {
  // Baseline guess for a few common anchors, otherwise 1L
  let baseMrp = 100000;
  const key = `${i.brand || ''} ${i.model || ''}`.toLowerCase();
  if (key.includes('s24') && key.includes('ultra')) baseMrp = 88000;   // approx street for 256GB
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

  // age factor (~1.5%/month decay up to 24m; mobiles)
  let ageFactor = 1.0;
  const m = i.age && i.age.match(/(\d+)\s*(month|months|yr|year|years?)/i);
  if (m) {
    const n = Number(m[1] || 0);
    const months = /month/.test(m[2]) ? n : n * 12;
    ageFactor = clip(1 - 0.015 * clip(months, 0, 24), 0.6, 1.0);
  }

  // bill/box small premium
  const bb = i.billBox ? 1.02 : 1.0;

  let mid = Math.round(baseMrp * factor * ageFactor * bb);

  // Crude extra adjustments (vehicles)
  const cat = (i.category || '').toLowerCase();
  const km = Number(i.kmDriven || 0) || 0;
  if (cat === 'cars') {
    if (km > 150000) mid = Math.round(mid * 0.90);
    else if (km > 100000) mid = Math.round(mid * 0.93);
    else if (km > 60000) mid = Math.round(mid * 0.96);
  } else if (cat === 'bikes') {
    if (km > 80000) mid = Math.round(mid * 0.90);
    else if (km > 50000) mid = Math.round(mid * 0.93);
    else if (km > 30000) mid = Math.round(mid * 0.96);
  }

  const low = Math.round(mid * 0.92);
  const high = Math.round(mid * 1.08);
  const suggest = Math.round((low + high) / 2);
  const quick = Math.round(low * 0.98);
  const patience = Math.round(high * 1.07);

  return {
    refs: {
      launch: `Approx new/launch reference around ₹${fmtINR(baseMrp)} (estimated).`,
      used: `Used market (heuristic): like-new often listed ₹${fmtINR(low)}–₹${fmtINR(high)}.`,
    },
    band: { low, high, suggest, quick, patience },
  };
}

/* ─────────────────────────────────────────
   Coerce OpenAI outputs → final shape
─────────────────────────────────────────── */
function coerceOpenAIToBand(json) {
  if (!json || typeof json !== 'object') return null;
  const bandSrc = json.band || json.priceBand || {};
  const out = {
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

  // Try parse from free text as fallback
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
  if (!out.band.low || !out.band.high) return null;
  return out;
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

    const prompt = `
You are a pricing advisor for Indian C2C classifieds. Return STRICT JSON ONLY:
{
 "refs": { "launch": "<1 line launch/new-price reference>", "used": "<1 line used range ref>" },
 "band": { "low": number, "high": number, "suggest": number, "quick": number, "patience": number }
}
Inputs:
brand=${input.brand}, model=${input.model}, category=${input.category}, subCategory=${input.subCategory},
condition=${input.condition}, billBox=${input.billBox}, age=${input.age}, kmDriven=${input.kmDriven},
city=${input.city}, state=${input.state}, userPrice=${input.price},
ownership=${input.ownership}, accidentStatus=${input.accidentStatus}, tyreCondition=${input.tyreCondition},
papers=${input.allPapersAvailable}, insuranceExpiry=${input.insuranceExpiry}, taxExpiry=${input.taxExpiry}, pollutionExpiry=${input.pollutionExpiry}.
Numbers must be INR (no commas in JSON numbers). Keep refs short, factual.
`.trim();

    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    const MODEL_PRIMARY = event.headers['x-openai-model'] || 'gpt-4.1-mini';

    if (!OPENAI_KEY) {
      const fb = fallbackHeuristic(input);
      fb.warning = 'OPENAI_API_KEY missing → heuristic';
      return ok(fb, event);
    }

    // Responses API (JSON mode, simple string input)
    async function callOpenAIResponses(promptStr, signal) {
      const r = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: MODEL_PRIMARY,
          input: promptStr,
          response_format: { type: 'json_object' },
        }),
        signal,
      });
      if (!r.ok) {
        const text = await r.text().catch(()=>'');
        const e = new Error('responses_api_error'); e.payload = text; throw e;
      }
      const data = await r.json();
      return (
        safeParseJSON(data.output_text) ||
        safeParseJSON(data?.output?.[0]?.content?.[0]?.text) ||
        (typeof data === 'object' && data.json ? data.json : null)
      );
    }

    // Chat fallback
    async function callOpenAIChat(promptStr, signal) {
      const chatModel = 'gpt-4o-mini';
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: chatModel,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'Return JSON only. No markdown.' },
            { role: 'user', content: promptStr },
          ],
        }),
        signal,
      });
      if (!r.ok) {
        const text = await r.text().catch(()=>'');
        const e = new Error('chat_api_error'); e.payload = text; throw e;
      }
      const data = await r.json();
      return safeParseJSON(data.choices?.[0]?.message?.content || '');
    }

    // Timeout + fallbacks
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 16000);
    let candidate = null;

    try {
      candidate = await callOpenAIResponses(prompt, ctrl.signal);
    } catch (e1) {
      try {
        candidate = await callOpenAIChat(prompt, ctrl.signal);
      } catch (e2) {
        const fb = fallbackHeuristic(input);
        fb.error = 'OpenAI error';
        fb.detail = (e1 && e1.payload ? e1.payload : String(e1)).slice(0, 900);
        clearTimeout(to);
        return ok(coerceOpenAIToBand(candidate) || fb, event);
      }
    } finally {
      clearTimeout(to);
    }

    // Coerce to final shape or fallback
    let final = coerceOpenAIToBand(candidate) || coerceOpenAIToBand({ json: candidate });
    if (!final) {
      const fb = fallbackHeuristic(input);
      fb.warning = 'AI parse fallback';
      return ok(fb, event);
    }

    // Sanity clamp
    const L = final.band.low, H = final.band.high;
    if (!(L > 0 && H > 0 && H >= L)) {
      const fb = fallbackHeuristic(input);
      fb.warning = 'AI invalid band → heuristic';
      return ok(fb, event);
    }

    return ok(final, event);
  } catch (e) {
    const input = (() => {
      try { return normalizeInput((safeParseJSON(event.body || '{}') || {}).input); } catch { return {}; }
    })();
    const fb = fallbackHeuristic(input || {});
    fb.error = String(e && e.message ? e.message : e);
    return ok(fb, event);
  }
};
