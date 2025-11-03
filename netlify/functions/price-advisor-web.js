// netlify/functions/price-advisor-web.js
const fetch = (...a) => import('node-fetch').then(({default:f}) => f(...a));

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors(event), body: '' };
  }
  try{
    const { input } = JSON.parse(event.body||'{}');
    if(!input) return json(400, {error:'missing input'});

    // Build a compact, consistent instruction
    const prompt = `
You are a pricing advisor for Indian C2C classifieds. Return STRICT JSON:
{
 "refs": { "launch": "<1 line launch/new-price reference>", "used": "<1 line used range ref>" },
 "band": { "low": number, "high": number, "suggest": number, "quick": number, "patience": number }
}
Inputs:
brand=${input.brand}, model=${input.model}, category=${input.category}, subCategory=${input.subCategory},
variant=256GB (if mentioned in user text), condition=${input.condition}, billBox=${input.billBox},
ageOrYear=${input.year || 'NA'}, kmDriven=${input.kmDriven || 'NA'},
city=${input.city}, state=${input.state}, userPrice=${input.price}.
Respond with realistic India INR numbers (no commas in JSON numbers). Keep it brief.
`;

    // OpenAI Responses (JSON mode)
    const r = await fetch('https://api.openai.com/v1/responses', {
      method:'POST',
      headers:{'content-type':'application/json', authorization:`Bearer ${process.env.OPENAI_API_KEY}`},
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        reasoning: { effort: "medium" },
        input: [
          {role:"system", content:"Return JSON only. No markdown."},
          {role:"user", content: prompt}
        ],
        response_format: { type: "json_object" }
      })
    });

    if(!r.ok){
      return json(400, { error: 'OpenAI error: '+ await r.text() });
    }
    const data = await r.json();
    const parsed = safeParseJSON(data.output?.[0]?.content?.[0]?.text) ||
                   safeParseJSON(data.output_text) || {};
    // shape → {refs:{launch,used}, band:{low,high,suggest,quick,patience}}
    return json(200, parsed);
  }catch(e){
    return json(500, {error:String(e.message||e)});
  }
};

/* utils */
function json(code, body){ return { statusCode: code, headers: cors(), body: JSON.stringify(body) }; }
function cors(){ return {
  "access-control-allow-origin":"*",
  "access-control-allow-methods":"POST,OPTIONS",
  "access-control-allow-headers":"content-type,x-plan",
};}
function safeParseJSON(s){ try{ return JSON.parse(s); }catch{ return null; } }
