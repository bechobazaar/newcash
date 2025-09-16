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

    const ipKey = (event.queryStringParameters && event.queryStringParameters.ipKey) || "";
    if (!ipKey) return err(400,{error:"ipKey required"});

    const adminSDK = getAdmin();
    const db = adminSDK.firestore();

    const ipRef = db.collection("ip_users").doc(ipKey);
    const doc = await ipRef.get();
    if (!doc.exists) return err(404,{error:"Not Found"});

    const d = doc.data()||{};
    const uids = Array.isArray(d.uids)? d.uids: [];

    const since = new Date(Date.now() - 30*24*60*60*1000);
    const hitsSnap = await ipRef.collection("hits")
      .where("at", ">=", adminSDK.firestore.Timestamp.fromDate(since))
      .orderBy("at","desc").limit(300).get();

    const hits = hitsSnap.docs.map(h=>{
      const x=h.data()||{};
      return { uid:x.uid||null, ua:x.ua||null, at: x.at && x.at.toDate ? x.at.toDate() : null };
    });

    return ok({ ok:true, ipKey, ip:d.ip||null, uids, hits });
  }catch(e){
    if (e.code==="NOT_ADMIN") return err(403,{error:"Forbidden"});
    console.error("get-ip-details", e);
    return err(500,{ok:false,error:e.message});
  }
};
