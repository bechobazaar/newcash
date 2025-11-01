// Node 18+ (Netlify default)
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

// === Keys (server-side only) ===
// You asked to inline your key since env space is tight; leaving your inline default here.
const GEMINI_KEY = process.env.GEMINI_API_KEY || "AIzaSyD6Uvvth0RMC-I44K3vcan13JcSKPyIZrw";
const MODELS_TRY = ["gemini-2.5-flash", "gemini-1.5-pro"]; // modern + fallback (v1beta)

const ok = (body, headers = {}) => ({
  statusCode: 200,
  headers: {
    "content-type": "application/json",
    // lock to your domain in prod (add netlify preview if you use it)
    "access-control-allow-origin": "https://bechobazaar.com",
    "access-control-allow-headers": "content-type,x-gemini-key,x-gemini-model",
    "access-control-allow-methods": "POST,OPTIONS",
    ...headers
  },
  body: typeof body === "string" ? body : JSON.stringify(body)
});
const err = (code, msg) => ok({ error: msg, code });

function forceJSON(t){
  if(!t) return null;
  try{ return JSON.parse(t); }catch{}
  const m=t.match(/```json\s*([\s\S]*?)```/i)||t.match(/```\s*([\s\S]*?)```/);
  if(m?.[1]) try{return JSON.parse(m[1])}catch{}
  const i=t.indexOf("{"),j=t.lastIndexOf("}");
  if(i!=-1&&j!=-1&&j>i) try{return JSON.parse(t.slice(i,j+1))}catch{}
  return null;
}
function bandsFromAnchor(p){
  const n=Number(p||0);
  if(!Number.isFinite(n)||n<=0)return null;
  return{
    quick:Math.round(n*0.92),
    suggested:Math.round(n),
    patient:Math.round(n*1.08),
    median:Math.round(n),
    p25:Math.round(n*0.95),
    p75:Math.round(n*1.05)
  };
}
function mkHeuristic(item){
  const place=[item?.area,item?.city,item?.state].filter(Boolean).join(", ");
  return{
    summary:"Heuristic preview (AI unavailable).",
    priceBands:bandsFromAnchor(item?.price)||{},
    marketNotes:"Limited data; cautious ±8%.",
    localReality:place?`Local demand considered for ${place}.`:"Locality unknown.",
    factors:[
      "Condition, age, storage variance (±5–12%).",
      "Box + bill + warranty improve resale potential.",
      "Good photos + battery/IMEI proof raise trust."
    ],
    listingCopy:{
      title:`${item?.brand||''} ${item?.model||''} — ${place}`,
      descriptionShort:"Clean condition. All functions OK. Full box/bill. Serious buyers only."
    },
    postingStrategy:[
      "Anchor slightly high; capture first 48h offers.",
      "No pings? Drop by ₹1–2k after 48–72h.",
      "Close within suggested band; carry bill/box for trust."
    ],
    caveats:["Heuristic (AI not used). Add comps for sharper advice."],
    compsUsed:[],
    sources:[]
  };
}

async function callGemini(model,key,parts){
  const url=`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const body={
    contents:[{role:"user",parts}],
    generationConfig:{temperature:0.2,topP:0.9,maxOutputTokens:1200}
  };
  const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  return{ok:r.ok,status:r.status,text:await r.text()};
}
async function callWithFallback(models,key,parts){
  const tries=[];
  for(const m of models){
    const r=await callGemini(m,key,parts);
    tries.push({model:m,status:r.status,ok:r.ok,body:r.text.slice(0,800)});
    if(r.ok){
      let d;try{d=JSON.parse(r.text);}catch{}
      const txt=d?.candidates?.[0]?.content?.parts?.[0]?.text||"";
      return{success:true,model:m,txt,tries};
    }
  }
  return{success:false,tries};
}

exports.handler=async(event)=>{
  if(event.httpMethod==="OPTIONS")return ok("");
  if(event.httpMethod!=="POST")return err(405,"Method Not Allowed");
  try{
    const {item,comps=[]}=JSON.parse(event.body||"{}");
    const hdr=Object.fromEntries(Object.entries(event.headers||{}).map(([k,v])=>[k.toLowerCase(),v]));
    const KEY=hdr["x-gemini-key"]||GEMINI_KEY;
    if(!KEY){const fb=mkHeuristic(item);return ok({...fb,debug:{usedAI:false,reason:"missing_key"}});}

    // 🔒 Ultra-strict JSON instruction with explicit shape
    const sys = `
You are a pricing analyst for an Indian classifieds marketplace.

Return JSON ONLY (no markdown). EXACT shape:
{
  "summary": "one paragraph",
  "priceBands": { "quick":0, "suggested":0, "patient":0, "median":0, "p25":0, "p75":0 },
  "marketNotes": "1–2 lines about India market context",
  "localReality": "1–2 lines reflecting the user's city/region",
  "factors": ["bullet points of why the price makes sense"],
  "listingCopy": { "title": "", "descriptionShort": "" },
  "postingStrategy": ["step 1","step 2","step 3"],
  "caveats": ["short bullet caveats"],
  "compsUsed": [{"title":"","price":0,"city":"","state":"","url":""}],
  "sources": [{"title":"","link":""}]
}

Rules:
- Use provided COMPS first; infer outliers & trim.
- Numbers must be INR whole integers.
- If comps are weak, derive cautious bands around user's anchor (if present) and explain caveats.
- Output ONLY valid JSON.
`.trim();

    const parts=[
      {text: sys},
      {text:"ITEM:"},{text:JSON.stringify(item||{})},
      {text:"COMPS:"},{text:JSON.stringify(comps||[])}
    ];

    const ai=await callWithFallback(MODELS_TRY,KEY,parts);
    if(!ai.success){const fb=mkHeuristic(item);return ok({...fb,debug:{usedAI:false,tries:ai.tries}});}

    const parsed=forceJSON(ai.txt);
    if(!parsed || typeof parsed!=="object"){
      const fb=mkHeuristic(item);
      return ok({...fb,debug:{usedAI:true,parsedOK:false,model:ai.model}});
    }

    if(parsed.priceBands && typeof parsed.priceBands==="object"){
      for(const k of ["quick","suggested","patient","median","p25","p75"]){
        const v=Number(parsed.priceBands[k]);
        if(Number.isFinite(v)) parsed.priceBands[k]=Math.round(v);
        else delete parsed.priceBands[k];
      }
    }

    return ok({...parsed,debug:{usedAI:true,parsedOK:true,model:ai.model}});
  }catch(e){
    return ok({error:String(e),debug:{usedAI:false,reason:"exception"}});
  }
};
