// netlify/functions/gemini-price.js
// Node 18+ runtime recommended

import fetch from 'node-fetch';

export const handler = async (event) => {
  // CORS (optional: relax for your domain only)
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: 'ok'
    };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: 'Method Not Allowed' };
  }

  try {
    const { features } = JSON.parse(event.body || '{}') || {};
    if (!features) throw new Error('Missing features');

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('Missing GEMINI_API_KEY');

    // Ask Gemini for a STRICT JSON object
    const prompt = buildPrompt(features);

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + encodeURIComponent(apiKey);
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({
        generationConfig: {
          temperature: 0.3,
          topP: 0.9,
          maxOutputTokens: 256,
          responseMimeType: "application/json"
        },
        contents: [{
          role: 'user',
          parts: [{ text: prompt }]
        }]
      })
    });

    if (!resp.ok) {
      const t = await resp.text();
      throw new Error('Gemini error: ' + t);
    }

    const json = await resp.json();
    const raw = json?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

    // Safe parse with fallback
    let out = {};
    try { out = JSON.parse(raw); } catch { out = {}; }

    // Return only the fields we expect
    const payload = {
      price_mid: numberOrNull(out.price_mid),
      price_min: numberOrNull(out.price_min),
      price_max: numberOrNull(out.price_max),
      confidence: (out.confidence || '').toString().slice(0, 40) // short
    };

    // Final guardrails for INR
    const clampN = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(n||0))));
    const floors = { Cars:10000, Bikes:2000, Mobiles:500, Electronics:400, Furniture:200, Fashion:100, Properties:1000, Others:100 };
    const cat = (features?.category)||'Others';
    const minFloor = floors[cat] ?? 100;

    const mid = clampN(payload.price_mid||0, minFloor, 200000000);
    const lo  = clampN(payload.price_min||Math.round(mid*0.9), minFloor, mid);
    const hi  = clampN(payload.price_max||Math.round(mid*1.1), mid, 200000000);

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ price_mid: mid, price_min: lo, price_max: hi, confidence: payload.confidence })
    };

  } catch (err) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: err.message || 'error' }) };
  }
};

function corsHeaders(){
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}

function numberOrNull(x){
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function buildPrompt(f){
  // very compact prompt; model must return strict JSON only
  return `
You are a pricing assistant for a used-goods marketplace in India.
Given the listing features below, estimate a fair INR price, with a sensible min and max range (same currency).
Be mindful of depreciation, condition hints, local demand via city/state, year of purchase, kms for vehicles, BHK/area for properties, etc.

Return STRICT JSON ONLY with keys: price_mid, price_min, price_max, confidence.
- Currency: INR (numbers only, no commas or symbols).
- price_min <= price_mid <= price_max
- confidence is a short label like "low" | "medium" | "high"

Features:
${JSON.stringify(f)}
`;
}
