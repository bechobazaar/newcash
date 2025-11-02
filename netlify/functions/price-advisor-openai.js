// netlify/functions/price-advisor-openai.js
// Node18+ on Netlify. No external deps.
// Uses OpenAI Responses API + built-in Web Search tool + Structured Outputs.

const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

const ok = (body, headers = {}) => ({
  statusCode: 200,
  headers: {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-openai-key",
    ...headers
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

const INR = (n) =>
  (n == null ? null :
   Math.round(Number(n)));

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return ok({ ok: true });
  if (event.httpMethod !== "POST") return bad(405, "Use POST");

  const OPENAI_KEY = process.env.OPENAI_API_KEY || event.headers["x-openai-key"];
  if (!OPENAI_KEY) return bad(400, "Missing OPENAI_API_KEY (env) or x-openai-key header.");

  let p = {};
  try { p = JSON.parse(event.body || "{}"); } catch { return bad(400, "Invalid JSON body"); }

  // Pull from your existing form fields
  const category    = (p.category || "").trim();
  const subCategory = (p.subCategory || "").trim();
  const brand       = (p.brand || "").trim();
  const model       = (p.model || "").trim();
  const title       = (p.title || "").trim();
  const descText    = (p.descriptionText || "").slice(0, 4000);
  const userPrice   = typeof p.userPrice === "number" ? p.userPrice : null;

  const loc   = p.location || {};
  const city  = (loc.city  || "").trim();
  const state = (loc.state || "").trim();
  const area  = (loc.area  || "").trim();

  const vehicle  = p.vehicle  || null; // optional (km, year, owners…)
  const property = p.property || null; // optional (bhk, area_sqft…)

  if (!category || !brand || !city) {
    return bad(400, "Missing required fields: category, brand, city");
  }

  // JSON Schema for Structured Outputs (guaranteed JSON shape)
  const schema = {
    name: "price_advisor_schema",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        new_price_est: {
          type: "object",
          additionalProperties: false,
          properties: {
            range_min: { type: ["integer","null"] },
            range_max: { type: ["integer","null"] },
            with_bank_offer_min: { type: ["integer","null"] }
          },
          required: ["range_min","range_max","with_bank_offer_min"]
        },
        used_price_est: {
          type: "object",
          additionalProperties: false,
          properties: {
            excellent: { type:"object", properties:{min:{type:["integer","null"]},max:{type:["integer","null"]}}, required:["min","max"] },
            good:      { type:"object", properties:{min:{type:["integer","null"]},max:{type:["integer","null"]}}, required:["min","max"] },
            refurbished:{type:"object", properties:{min:{type:["integer","null"]},max:{type:["integer","null"]}}, required:["min","max"] }
          },
          required: ["excellent","good","refurbished"]
        },
        sources: {
          type: "object",
          additionalProperties: false,
          properties: {
            retail: { type:"array", items:{ type:"object", properties:{title:{type:"string"},url:{type:"string"}}, required:["url"] } },
            used:   { type:"array", items:{ type:"object", properties:{title:{type:"string"},url:{type:"string"}}, required:["url"] } }
          },
          required: ["retail","used"]
        },
        notes: { type: "string" },
        derived: {
          type: "object",
          additionalProperties: false,
          properties: {
            condition: { type:["string","null"] },
            age:       { type:["string","null"] },
            battery_health:{ type:["string","null"] },
            box_bill:  { type:["string","null"] },
            warranty:  { type:["string","null"] },
            km:        { type:["string","null"] },
            year:      { type:["string","null"] },
            owners:    { type:["string","null"] },
            area_sqft: { type:["string","null"] },
            bhk:       { type:["string","null"] },
            city:      { type:["string","null"] },
            state:     { type:["string","null"] },
            model_resolved:{ type:["string","null"] }
          }
        }
      },
      required: ["new_price_est","used_price_est","sources","notes","derived"]
    }
  };

  const system = [
    "You are a pricing analyst for India. Use the Web Search tool to fetch CURRENT Indian prices.",
    "Prefer reputable Indian sources for NEW (brand stores, Croma, Reliance Digital, Vijay Sales, Amazon/Flipkart).",
    "For USED, prefer OLX, Quikr, Cashify, Cars24/Bikes24, refurbished outlets.",
    "Derive details from title/description if not provided (e.g., phone battery %, box+bill, age; vehicle km/year/owners; property area/BHK).",
    "Return INR integers and realistic ranges. Ignore outliers. Keep it concise.",
  ].join("\n");

  const facts = {
    category, subCategory, brand, model, title,
    descriptionText: descText,
    location: { area, city, state, country: "India" },
    vehicle, property, userPrice
  };

  const body = {
    model: "gpt-4o-search-preview",                 // search-enabled model
    // Built-in tools → enable Web Search
    tools: [{ type: "web_search" }],
    input: [
      { role: "system", content: system },
      {
        role: "user",
        content:
          "Use web_search to find current India market prices and then produce JSON per schema. " +
          "Facts:\n" + JSON.stringify(facts, null, 2)
      }
    ],
    // Structured Outputs (guaranteed JSON)
    response_format: { type: "json_schema", json_schema: schema }
  };

  try {
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      timeout: 45000
    });

    const raw = await r.text();
    if (!r.ok) return bad(r.status, raw || "OpenAI error");

    let result;
    try { result = JSON.parse(raw); } catch { return bad(502, "OpenAI JSON parse error", { raw }); }

    // The Responses API returns output in 'output[0].content[0].text' or 'output_text'
    const out =
      result.output_text
      || result.output?.[0]?.content?.[0]?.text
      || result.output?.[0]?.content?.[0]?.input_text
      || null;

    if (!out) return bad(502, "No structured output from model", { result });

    let data;
    try { data = JSON.parse(out); } catch { return bad(502, "Structured output parse failed", { out }); }

    // Normalize integers
    const nx = data.new_price_est || {};
    const ux = data.used_price_est || {};
    if (nx) {
      nx.range_min = INR(nx.range_min);
      nx.range_max = INR(nx.range_max);
      nx.with_bank_offer_min = INR(nx.with_bank_offer_min);
    }
    const norm = (r) => r ? { min: INR(r.min), max: INR(r.max) } : {min:null,max:null};
    if (ux) {
      ux.excellent = norm(ux.excellent);
      ux.good      = norm(ux.good);
      ux.refurbished = norm(ux.refurbished);
    }

    // Optional user price compare
    if (userPrice != null && ux?.good?.min != null && ux?.good?.max != null) {
      data.user_compare =
        (userPrice < ux.good.min) ? "Your price is lower than the Good range." :
        (userPrice > ux.good.max) ? "Your price is higher than the Good range." :
        "Your price is within the Good range.";
    }

    data.grounded = true;
    data.provider = "openai";

    return ok({ ok: true, data });
  } catch (e) {
    return bad(502, e.message || "Backend failure");
  }
};
