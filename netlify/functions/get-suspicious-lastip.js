// netlify/functions/get-suspicious-lastip.js
const admin = require("firebase-admin");

const ORIGIN = "https://bechobazaar.com";
const CORS = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};
const ok  = (b,h)=>({ statusCode:200, headers:{...CORS, ...(h||{})}, body:JSON.stringify(b) });
const err = (s,b)=>({ statusCode:s, headers:CORS, body:JSON.stringify(b) });
const noc = ()=>({ statusCode:204, headers:CORS, body:"" });

let inited=false;
function getAdmin(){
  if (inited) return admin;
  const b64=process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error("FIREBASE_SERVICE_ACCOUNT_B64 missing");
  const svc=JSON.parse(Buffer.from(b64,"base64").toString("utf8"));
  if (svc.private_key) svc.private_key = svc.private_key.replace(/\\n/g,"\n");
  admin.initializeApp({ credential: admin.credential.cert(svc) });
  inited=true; return admin;
}

function ipKey(ip){ return (ip||"unknown").trim().replace(/[^\w]/g,"_").toLowerCase().slice(0,200); }

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
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return err(401,{error:"Missing token"});
    await requireAdmin(token);

    const db = getAdmin().firestore();
    const snap = await db.collection("users").get();

    // Group users by lastIP
    const byIp = new Map(); // key -> { ip, users: [{uid,email,phone,displayName,lastLogin,lastActive}] }
    snap.forEach(doc=>{
      const d = doc.data() || {};
      const ip = (d.lastIP || "").trim();
      if (!ip) return;
      const key = ipKey(ip);
      if (!byIp.has(key)) byIp.set(key, { ip, users: [] });
      byIp.get(key).users.push({
        uid: doc.id,
        email: (d.email || "").trim(),
        phone: (d.phoneNumber || "").trim(),
        displayName: d.displayName || "",
        lastLogin: d.lastLogin && d.lastLogin.toDate ? d.lastLogin.toDate() : null,
        lastActive: d.lastActive && d.lastActive.toDate ? d.lastActive.toDate() : null,
      });
    });

    // Pick only suspicious groups: >=2 users AND (emails differ OR phones differ)
    const results = [];
    for (const [key, g] of byIp.entries()){
      const users = g.users;
      if (users.length < 2) continue;

      const emails = new Set(users.map(u=>u.email).filter(Boolean));
      const phones = new Set(users.map(u=>u.phone).filter(Boolean));
      const emailDiff = emails.size >= 2;         // different emails present
      const phoneDiff = phones.size >= 2;         // different phones present

      if (!emailDiff && !phoneDiff) continue;     // we only care if email/phone differs

      const lastSeen = users.reduce((acc,u)=>{
        const t = u.lastLogin || u.lastActive || null;
        return (!acc || (t && t > acc)) ? t : acc;
      }, null);

      results.push({
        ip, ipKey: key,
        count: users.length,
        emailDiff, phoneDiff,
        emails: Array.from(emails),
        phones: Array.from(phones),
        lastSeen,
        users, // full list for modal
      });
    }

    // Sort by recent activity
    results.sort((a,b)=> (new Date(b.lastSeen||0)) - (new Date(a.lastSeen||0)));

    return ok({ ok:true, results });
  }catch(e){
    if (e.code==="NOT_ADMIN") return err(403,{error:"Forbidden"});
    console.error("get-suspicious-lastip", e);
    return err(500,{ok:false,error:e.message});
  }
};
