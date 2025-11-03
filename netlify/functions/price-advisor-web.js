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

  // bill/box small premium
  const bb = i.billBox ? 1.02 : 1.0;

  const mid = Math.round(baseMrp * factor * ageFactor * bb);
  const low = Math.round(mid * 0.92);
  const high = Math.round(mid * 1.08);
  const suggest = Math.round((low + high) / 2);
  const quick = Math.round(low * 0.98);
  const patience = Math.round(high * 1.07);

  return {
    refs: {
      launch: `Approx new/launch reference around ₹${fmtINR(baseMrp)} for this variant (estimated).`,
      used: `Used market (heuristic): like-new items often listed in ₹${fmtINR(low)}–₹${fmtINR(high)} range.`,
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
city=${input.city}, state=${input.state}, userPrice=${input.price}.
Numbers must be Indian INR (no commas in JSON numbers). Keep refs short, factual.
`.trim();

    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    const MODEL_PRIMARY = event.headers['x-openai-model'] || 'gpt-4.1-mini';
    if (!OPENAI_KEY) {
      const fb = fallbackHeuristic(input);
      fb.warning = 'OPENAI_API_KEY missing → heuristic';
      return ok(fb, event);
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
        }),
        signal,
      });

      if (!r.ok) {
        const text = await r.text().catch(()=>'');
        const err = new Error('responses_api_error');
        err.payload = text;
        throw err;
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
          messages: [
            { role: 'system', content: 'Return JSON only. No markdown.' },
            { role: 'user', content: promptStr },
          ],
        }),
        signal,
      });

      if (!r.ok) {
        const text = await r.text().catch(()=>'');
        const err = new Error('chat_api_error');
        err.payload = text;
        throw err;
      }

      const data = await r.json();
      const txt = data.choices?.[0]?.message?.content || '';
      return safeParseJSON(txt);
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
        // Try coercing if candidate has something, else fallback object
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
