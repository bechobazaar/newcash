// netlify/functions/get-suspicious-lastip.js
const admin = require("firebase-admin");

// ----- CORS -----
const ORIGIN = "https://bechobazaar.com";
const CORS = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};
const ok  = (b,h)=>({ statusCode:200, headers:{...CORS, ...(h||{})}, body:JSON.stringify(b) });
const err = (s,b)=>({ statusCode:s, headers:CORS, body:JSON.stringify(b) });
const noc = ()=>({ statusCode:204, headers:CORS, body:"" });

// ----- Admin init -----
let inited=false;
function getAdmin(){
  if (inited) return admin;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error("FIREBASE_SERVICE_ACCOUNT_B64 missing");
  const svc = JSON.parse(Buffer.from(b64,"base64").toString("utf8"));
  if (svc.private_key) svc.private_key = svc.private_key.replace(/\\n/g,"\n");
  admin.initializeApp({ credential: admin.credential.cert(svc) });
  inited = true; return admin;
}

async function requireAdmin(token){
  const dec = await getAdmin().auth().verifyIdToken(token);
  if (!dec || dec.admin !== true){ const e=new Error("NOT_ADMIN"); e.code="NOT_ADMIN"; throw e; }
  return dec;
}

// ----- Helpers -----
function normStr(x){ return (x==null ? "" : String(x)).trim(); }
function ipKey(ip){
  return normStr(ip).replace(/[^\w]/g,"_").toLowerCase().slice(0,200);
}
function toISO(ts){
  try{
    if (!ts) return null;
    if (typeof ts === "string") return ts;            // already string
    if (ts.toDate) return ts.toDate().toISOString();  // Firestore Timestamp
    if (ts instanceof Date) return ts.toISOString();
    return null;
  }catch{ return null; }
}

exports.handler = async (event)=>{
  if (event.httpMethod === "OPTIONS") return noc();
  if (event.httpMethod !== "GET")     return err(405,{error:"Method Not Allowed"});

  try{
    // auth
    const h = event.headers || {};
    const auth = h.authorization || h.Authorization || "";
    const token = auth.startsWith("Bearer ")? auth.slice(7): null;
    if (!token) return err(401,{error:"Missing token"});
    await requireAdmin(token);

    // query params
    const qp = event.queryStringParameters || {};
    const minCount = Math.max(2, parseInt(qp.min || "2", 10) || 2);
    const limitUsers = Math.min(50000, Math.max(100, parseInt(qp.limit || "5000", 10) || 5000));
    const perGroupCap = Math.min(500, Math.max(10, parseInt(qp.groupCap || "100", 10) || 100));

    const db = getAdmin().firestore();

    // Only pull required fields to reduce payload & errors
    let q = db.collection("users")
      .select("lastIP","email","phoneNumber","displayName","lastLogin","lastActive")
      .limit(limitUsers); // guardrails

    const snap = await q.get();

    // Group by lastIP
    const byIp = new Map(); // key -> { ip, users: [] }
    let scanned = 0, skipped = 0, bad = 0;

    for (const doc of snap.docs){
      scanned++;
      try{
        const d = doc.data() || {};
        const ip = normStr(d.lastIP);
        if (!ip) { skipped++; continue; }

        const k = ipKey(ip);
        if (!byIp.has(k)) byIp.set(k, { ip, users: [] });

        const u = {
          uid: doc.id,
          email: normStr(d.email),
          phone: normStr(d.phoneNumber),
          displayName: normStr(d.displayName),
          lastLogin: toISO(d.lastLogin),
          lastActive: toISO(d.lastActive),
        };
        byIp.get(k).users.push(u);
      }catch{
        bad++;
      }
    }

    // Build suspicious results
    const results = [];
    for (const [k, g] of byIp.entries()){
      const arr = g.users || [];
      if (arr.length < minCount) continue;

      const emails = new Set(arr.map(u=>u.email).filter(Boolean));
      const phones = new Set(arr.map(u=>u.phone).filter(Boolean));
      const emailDiff = emails.size >= 2;
      const phoneDiff = phones.size >= 2;
      if (!emailDiff && !phoneDiff) continue;

      // lastSeen from lastLogin/lastActive
      let lastSeen = null;
      for (const u of arr){
        const cand = u.lastLogin || u.lastActive;
        if (!cand) continue;
        if (!lastSeen || cand > lastSeen) lastSeen = cand;
      }

      results.push({
        ip: g.ip,
        ipKey: k,
        count: arr.length,
        emailDiff, phoneDiff,
        emails: Array.from(emails).slice(0,50),
        phones: Array.from(phones).slice(0,50),
        lastSeen,
        users: arr.slice(0, perGroupCap) // cap to keep response small
      });
    }

    // Sort newest first
    results.sort((a,b)=>{
      const ax = a.lastSeen ? Date.parse(a.lastSeen) : 0;
      const bx = b.lastSeen ? Date.parse(b.lastSeen) : 0;
      return bx - ax;
    });

    return ok({ ok:true, results, meta:{ scanned, skipped, bad, groups: results.length } });
  }catch(e){
    if (e.code==="NOT_ADMIN") return err(403,{error:"Forbidden"});
    // Return the message so you can see root cause in the browser
    return err(500,{ok:false,error: e.message || String(e)});
  }
};
