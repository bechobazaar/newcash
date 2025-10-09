// netlify/functions/send-appilix-push.js
const ALLOWED_ORIGINS = new Set([
  'https://bechobazaar.com',
  'https://www.bechobazaar.com',
  'http://localhost:3000',
  'http://localhost:5173',
]);
function corsHeaders(origin){
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://bechobazaar.com';
  return {
    'Access-Control-Allow-Origin': allow,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

exports.handler = async (event)=>{
  const headers = corsHeaders(event.headers?.origin||'');
  if (event.httpMethod==='OPTIONS') return {statusCode:204, headers, body:''};
  if (event.httpMethod!=='POST')   return {statusCode:405, headers, body:'Method Not Allowed'};

  try{
    const { user_identity, title, message, open_link_url } = JSON.parse(event.body||'{}');

    // ==== REAL CALL (example – fill your Appilix details) ====
    // const r = await fetch(process.env.APPILIX_PUSH_URL, {
    //   method:'POST',
    //   headers:{
    //     'Content-Type':'application/json',
    //     'Authorization':`Bearer ${process.env.APPILIX_API_KEY}`
    //   },
    //   body: JSON.stringify({ user_identity, title, message, open_link_url })
    // });
    // const text = await r.text();

    // Stub (until real API wired):
    const text = JSON.stringify({ status: "false", msg: "User identity is not found." });

    return { statusCode: 200, headers, body: JSON.stringify({ ok:true, result:{ status:200, text }}) };
  }catch(e){
    return { statusCode: 500, headers, body: JSON.stringify({ ok:false, error:String(e?.message||e) }) };
  }
};
