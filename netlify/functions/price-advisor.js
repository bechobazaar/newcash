// Node 18+ (Netlify). No env needed since you asked to inline the key.
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

// ---- INLINE KEY (server-side only) ----
const GEMINI_KEY = "AIzaSyD6Uvvth0RMC-I44K3vcan13JcSKPyIZrw";

// Optional: Google CSE (leave blank if not used)
const CSE_KEY = ""; 
const CSE_CX  = "";

// Use v1 + “-latest” model ids (most widely enabled)
const MODELS_TRY = [
  "gemini-1.5-flash-latest",
  "gemini-1.5-flash-8b-latest",
  "gemini-1.5-pro-latest"
];

const ok = (body, headers = {}) => ({
  statusCode: 200,
  headers: {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type,x-gemini-key,x-cse-key,x-cse-cx,x-gemini-model",
    "access-control-allow-methods": "POST, OPTIONS",
    ...headers
  },
  body: typeof body === "string" ? body : JSON.stringify(body)
});
const err = (code, msg) => ok({ error: msg, code });

function forceJSON(text){
  if(!text) return null;
  try{ return JSON.parse(text); }catch{}
  const m = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/);
  if(m?.[1]){ try{ return JSON.parse(m[1]); }catch{} }
  const i = text.indexOf("{"), j = text.lastIndexOf("}");
  if(i!==-1 && j!==-1 && j>i){ try{ return JSON.parse(text.slice(i, j+1)); }catch{} }
  return null;
}
function fallbackFromAnchor(anchor){
  const p = Number(anchor||0);
  if(!Number.isFinite(p) || p<=0) return null;
  return {
    quick: Math.round(p*0.92),
    suggested: Math.round(p),
    patient: Math.round(p*1.08),
    median: Math.round(p),
    p25: Math.round(p*0.95),
    p75: Math.round(p*1.05)
  };
}
async function googleCSESnippets(qArr, key, cx){
  if(!key || !cx) return [];
  const out=[];
  for(const q of qArr){
    try{
      const r = await fetch(
        `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&num=3&q=${encodeURIComponent(q)}`
      );
      if(!r.ok) continue;
      const data = await r.json();
      out.push({ query:q, items:(data.items||[]).map(it=>({title:it.title, link:it.link, snippet:it.snippet})) });
    }catch{}
  }
  return out;
}

// ---- v1 endpoint
async function callGeminiOnce(model, key, userParts){
  const endpoint = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent`;
  const body = {
    contents: [{ role: "user", parts: userParts }],
    generationConfig: { temperature: 0.2, topP: 0.9, maxOutputTokens: 1200 }
  };
  const r = await fetch(`${endpoint}?key=${encodeURIComponent(key)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

async function callGeminiWithFallback(models, key, userParts){
  const tries=[];
  for(const m of models){
    const res = await callGeminiOnce(m, key, userParts);
    tries.push({ model:m, status:res.status, ok:res.ok, body:res.text.slice(0, 2000) });
    if(res.ok){
      let data; try{ data = JSON.parse(res.text); }catch{ data = null; }
      const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return { success:true, model:m, txt, tries };
    }
  }
  return { success:false, model:null, txt:"", tries };
}

function mkHeuristicWriteup(item){
  const b = fallbackFromAnchor(Number(item?.price||0)) || {};
  const place = [item?.area,item?.city,item?.state].filter(Boolean).join(", ");
  return {
    summary: "Heuristic preview based on entered details (AI unavailable).",
    priceBands: b,
    marketNotes: "Limited signals; cautious bands around your entered/typical price.",
    localReality: place ? `Local demand considered for ${place}.` : "Local nuance unknown.",
    factors: [
      "Condition/age/storage drive variance (±5–12%).",
      "Box + bill + warranty improve resale.",
      "Good photos + battery health proof raise trust."
    ],
    listingCopy: {
      title: `${item?.brand||''} ${item?.model||''} — ${place}`,
      descriptionShort: "Personal use, clean condition. All functions OK. Bill/box available. Genuine buyers only."
    },
    postingStrategy: [
      "Start a bit high; optimize in 48–72h.",
      "No offers? Reduce by ₹1–2k.",
      "Close in suggested band; carry bill/box."
    ],
    caveats: ["Heuristic (AI not used). Add comps or enable AI for sharper advice."],
    compsUsed: [], sources: []
  };
}

exports.handler = async (event)=>{
  if(event.httpMethod === "OPTIONS") return ok("");
  if(event.httpMethod !== "POST") return err(405,"Method Not Allowed");

  try{
    const { item, comps = [], wantWeb = false } = JSON.parse(event.body || "{}");
    const hdr = Object.fromEntries(Object.entries(event.headers||{}).map(([k,v])=>[k.toLowerCase(), v]));
    // allow header override too
    const KEY = (hdr["x-gemini-key"] || GEMINI_KEY || "").trim();
    const OVERRIDE_MODEL = hdr["x-gemini-model"];

    const queries = [
      [item?.brand, item?.model, item?.variant, "India price"].filter(Boolean).join(" "),
      `${item?.brand||""} ${item?.model||""} used price India`,
      `${item?.brand||""} ${item?.model||""} resale value India`
    ].filter(Boolean);
    const webSnippets = wantWeb ? await googleCSESnippets(queries, CSE_KEY, CSE_CX) : [];

    if(!KEY){
      const fb = mkHeuristicWriteup(item);
      return ok({ ...fb, debug:{ usedAI:false, reason:"missing_key" } });
    }

    const sys = `
You are a pricing analyst for an Indian classifieds marketplace.
PRIORITIES:
1) Use provided COMPS first; PUBLIC_SNIPPETS only as supporting signals.
2) Trim outliers; consider condition/age/storage/region if derivable.
3) Return INR whole integers.

STRICT JSON ONLY:
{
  "summary": "1 short paragraph",
  "priceBands": { "quick":0, "suggested":0, "patient":0, "median":0, "p25":0, "p75":0 },
  "marketNotes": "1–2 lines",
  "localReality": "1–2 lines",
  "factors": ["..."],
  "listingCopy": { "title":"","descriptionShort":"" },
  "postingStrategy": ["..."],
  "caveats": ["..."],
  "compsUsed": [{"title":"","price":0,"city":"","state":"","url":""}],
  "sources": [{"title":"","link":""}]
}
If evidence is weak, derive conservative bands around user's price and explain caveats. Output JSON only.`;

    const userParts = [
      { text: sys.trim() },
      { text: "ITEM:" },            { text: JSON.stringify(item||{}) },
      { text: "COMPS:" },           { text: JSON.stringify(comps||[]) },
      { text: "PUBLIC_SNIPPETS:" }, { text: JSON.stringify(webSnippets||[]) }
    ];

    const models = OVERRIDE_MODEL ? [OVERRIDE_MODEL] : MODELS_TRY;
    const ai = await callGeminiWithFallback(models, KEY, userParts);

    if(!ai.success){
      const fb = mkHeuristicWriteup(item);
      return ok({ ...fb, debug:{ usedAI:false, tries: ai.tries } });
    }

    const parsed = forceJSON(ai.txt);
    if(!parsed || typeof parsed!=="object"){
      const fb = mkHeuristicWriteup(item);
      return ok({ ...fb, debug:{ usedAI:true, model: ai.model, parsedOK:false, rawLen: ai.txt.length } });
    }

    // sanitize numbers
    if(parsed.priceBands && typeof parsed.priceBands==="object"){
      for(const k of ["quick","suggested","patient","median","p25","p75"]){
        const n = Number(parsed.priceBands[k]);
        if(Number.isFinite(n)) parsed.priceBands[k] = Math.round(n); else delete parsed.priceBands[k];
      }
    }

    return ok({
      summary: parsed.summary || "",
      priceBands: parsed.priceBands || {},
      marketNotes: parsed.marketNotes || "",
      localReality: parsed.localReality || "",
      factors: parsed.factors || [],
      listingCopy: parsed.listingCopy || { title:"", descriptionShort:"" },
      postingStrategy: parsed.postingStrategy || [],
      caveats: parsed.caveats || [],
      compsUsed: Array.isArray(parsed.compsUsed)? parsed.compsUsed.slice(0,20):[],
      sources: Array.isArray(parsed.sources)? parsed.sources.slice(0,20):[],
      debug: { usedAI:true, model: ai.model, parsedOK:true }
    });

  }catch(e){
    const fb = mkHeuristicWriteup((()=>{ try{return JSON.parse(event.body||"{}")?.item;}catch{} return {}; })());
    return ok({ ...fb, caveats:[...(fb.caveats||[]), "Function crashed."], debug:{ usedAI:false, reason:"exception", error:String(e?.message||e) } });
  }
};
