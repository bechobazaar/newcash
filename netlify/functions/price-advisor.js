// Node 18+ (Netlify default)
const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));

// === Keys (server-side only) ===
const GEMINI_KEY = process.env.GEMINI_API_KEY || "AIzaSyD6Uvvth0RMC-I44K3vcan13JcSKPyIZrw";
const MODELS_TRY = ["gemini-2.5-flash", "gemini-1.5-pro"]; // modern + fallback

const ok = (body, headers = {}) => ({
  statusCode: 200,
  headers: {
    "content-type": "application/json",
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
function fallbackBands(p){
  const n=Number(p||0);
  if(!Number.isFinite(n)||n<=0)return null;
  return{quick:n*0.92|0,suggested:n|0,patient:n*1.08|0,median:n|0,p25:n*0.95|0,p75:n*1.05|0};
}
function mkHeuristic(item){
  const place=[item?.area,item?.city,item?.state].filter(Boolean).join(", ");
  return{
    summary:"Heuristic preview (AI unavailable).",
    priceBands:fallbackBands(item?.price)||{},
    marketNotes:"Limited data; cautious ±8 %.",
    localReality:place?`Local demand considered for ${place}.`:"Locality unknown.",
    factors:["Condition, age, storage","Box + bill + warranty raise trust","Good photos = better reach"],
    listingCopy:{title:`${item?.brand||''} ${item?.model||''} — ${place}`,descriptionShort:"Clean condition, all functions OK. Bill + box included."},
    postingStrategy:["Start slightly high","Drop ₹1-2 k after 48 h if no offers","Close near suggested band"],
    caveats:["Heuristic only"],compsUsed:[],sources:[]
  };
}

async function callGemini(model,key,parts){
  const url=`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const body={contents:[{role:"user",parts}],generationConfig:{temperature:0.2,maxOutputTokens:1200}};
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
    const sys=`You are a pricing analyst for an Indian classifieds app.
Return STRICT JSON with summary, priceBands, marketNotes, localReality, factors, listingCopy, postingStrategy, caveats.`;
    const parts=[{text:sys},{text:"ITEM:"},{text:JSON.stringify(item||{})},{text:"COMPS:"},{text:JSON.stringify(comps||[])}];
    const ai=await callWithFallback(MODELS_TRY,KEY,parts);
    if(!ai.success){const fb=mkHeuristic(item);return ok({...fb,debug:{usedAI:false,tries:ai.tries}});}
    const parsed=forceJSON(ai.txt);
    if(!parsed){const fb=mkHeuristic(item);return ok({...fb,debug:{usedAI:true,parsedOK:false,model:ai.model}});}
    if(parsed.priceBands)for(const k of Object.keys(parsed.priceBands)){const v=Number(parsed.priceBands[k]);if(!Number.isFinite(v))delete parsed.priceBands[k];else parsed.priceBands[k]=Math.round(v);}
    return ok({...parsed,debug:{usedAI:true,model:ai.model}});
  }catch(e){return ok({error:String(e)})}
};
