const admin = require("firebase-admin");
const ORIGIN = "https://bechobazaar.com";
const CORS = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};
const ok=(b,h)=>({statusCode:200,headers:{...CORS,...(h||{})},body:JSON.stringify(b)});
const err=(s,b)=>({statusCode:s,headers:CORS,body:JSON.stringify(b)});
const noc=()=>({statusCode:204,headers:CORS,body:""});

let inited=false;
function getAdmin(){
  if (inited) return admin;
  const b64=process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  const svc=JSON.parse(Buffer.from(b64,'base64').toString('utf8'));
  if (svc.private_key) svc.private_key = svc.private_key.replace(/\\n/g,"\n");
  admin.initializeApp({ credential: admin.credential.cert(svc) });
  inited=true; return admin;
}
async function requireAdmin(token){
  const dec = await getAdmin().auth().verifyIdToken(token);
  if (!dec || dec.admin !== true){ const e=new Error("NOT_ADMIN"); e.code="NOT_ADMIN"; throw e; }
  return dec;
}

exports.handler = async (event)=>{
  if (event.httpMethod === "OPTIONS") return noc();
  if (event.httpMethod !== "GET")     return err(405,{error:"Method Not Allowed"});

  try{
    const auth = event.headers.authorization || event.headers.Authorization || "";
    const token = auth.startsWith("Bearer ")? auth.slice(7): null;
    if (!token) return err(401,{error:"Missing token"});
    await requireAdmin(token);

    const db = getAdmin().firestore();
    const snap = await db.collection("ip_users").orderBy("lastSeen","desc").limit(300).get();
    const results=[];
    snap.forEach(d=>{
      const x=d.data()||{};
      const u=Array.isArray(x.uids)?x.uids:[];
      if (u.length>=2) results.push({ ipKey:d.id, ip:x.ip||null, uids:u, lastSeen:x.lastSeen?x.lastSeen.toDate():null });
    });
    return ok({ ok:true, results });
  }catch(e){
    if (e.code==="NOT_ADMIN") return err(403,{error:"Forbidden"});
    console.error("get-suspicious-ips", e);
    return err(500,{ok:false,error:e.message});
  }
};
