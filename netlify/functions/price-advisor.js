// netlify/functions/price-advisor.js
// Node 18+ runtime

const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

/** ──────────────────────────────────────────────────────────────────────
 *  CONFIG
 *  Set env var: GEMINI_API_KEY in Netlify dashboard.
 *  (Optional) You may override by sending header "x-gemini-key" from admin-only clients.
 *  ────────────────────────────────────────────────────────────────────── */
const MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const GEMINI_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const ok = (body, extraHeaders = {}) => ({
  statusCode: 200,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-gemini-key",
    "access-control-allow-methods": "POST, OPTIONS",
    ...extraHeaders
  },
  body: JSON.stringify(body)
});
const bad = (code, msg) => ({
  statusCode: code,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-gemini-key",
    "access-control-allow-methods": "POST, OPTIONS",
  },
  body: JSON.stringify({ error: msg })
});

exports.handler = async (ev) => {
  if (ev.httpMethod === "OPTIONS") return ok({});

  if (ev.httpMethod !== "POST") return bad(405, "Use POST");

  let key = ev.headers["x-gemini-key"] || process.env.GEMINI_API_KEY;
  if (!key) return bad(401, "Missing GEMINI_API_KEY");

  let payload;
  try { payload = JSON.parse(ev.body || "{}"); }
  catch { return bad(400, "Invalid JSON"); }

  const { item = {}, comps = [] } = payload;

  // Basic sanity
  const must = ["category","brand","title","city","state"];
  for (const m of must) {
    if (!(item[m] && String(item[m]).trim())) {
      return bad(400, `Missing item.${m}`);
    }
  }

  // Compute market bands from comps (robust even if comps are few)
  const prices = comps
    .map(c => Number(c.price))
    .filter(n => Number.isFinite(n) && n > 0)
    .sort((a,b)=>a-b);

  const pct = (p) => {
    if (!prices.length) return null;
    const idx = (p/100) * (prices.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return prices[lo];
    const t = idx - lo;
    return prices[lo]*(1-t) + prices[hi]*t;
  };

  const median = pct(50);
  const p25    = pct(25);
  const p75    = pct(75);

  // Suggested bands (fallback when comps are empty)
  const quick     = median ? Math.round(median * 0.96) : (item.price ? Math.round(item.price*0.95) : null);
  const suggested = median ? Math.round(median)        : (item.price || null);
  const patient   = median ? Math.round(median * 1.05) : (item.price ? Math.round(item.price*1.05) : null);

  const priceBands = { quick, suggested, patient, median, p25, p75 };

  // Build compact comps digest for prompting (limit 30 to save tokens)
  const topComps = comps.slice(0, 30).map(c => ({
    price: c.price,
    title: c.title?.slice(0, 80) || "",
    brand: c.brand || "",
    model: c.model || "",
    city : c.city || "",
    state: c.state || ""
  }));

  // Prompt
  const sys = `
You are a marketplace pricing analyst for a used-goods classifieds app in India.
Write a tight, non-fluffy assessment the seller can read in 10–12 seconds.
Tone: precise, confident, friendly. No marketing jargon. Avoid hallucination.
If comps are few, say so clearly.
Always output a one-paragraph summary and 3–5 bullet strategy points.
Use Indian rupee style (e.g., ₹1,24,999). Avoid ranges like "10–50k" if not justified.
Say if the entered price is Overpriced / Fair / Undervalued relative to comps.
`.trim();

  // Format a small markdown block
  const user = {
    item,
    priceBands,
    comps: topComps
  };

  const reqBody = {
    contents: [{
      role: "user",
      parts: [
        { text: sys },
        { text: "ITEM JSON:" },
        { text: JSON.stringify(user, null, 2) },
        { text: `
Return JSON with keys:
- summary (string, ≤ 60 words)
- strategy (array of 3–5 short bullet strings)
- caveats (array; empty if none)
No markdown in JSON values. Keep it factual.
`.trim() }
      ]
    }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 512
    }
  };

  let aiJson = { summary: "", strategy: [], caveats: [] };
  try {
    const r = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody)
    });
    if (!r.ok) {
      const t = await r.text();
      return ok({ priceBands, report: aiJson, caveats: [`Gemini API error: ${t}`], debug: { status: r.status, body: t } });
    }
    const data = await r.json();
    const txt = data?.candidates?.[0]?.content?.parts?.map(p=>p.text).join("\n") || "{}";
    // The model returns JSON string; parse safely
    try { aiJson = JSON.parse(txt); } catch { aiJson = { summary: txt.slice(0, 400), strategy: [], caveats: ["Could not parse full JSON"] }; }
  } catch (e) {
    return ok({ priceBands, report: aiJson, caveats: [`Gemini call failed: ${String(e.message||e)}`] });
  }

  return ok({
    priceBands,
    report: aiJson
  });
};
