const admin = require("firebase-admin");

/* ==== CORS ==== */
const ORIGIN = "https://bechobazaar.com";
const CORS = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};
const ok  = (b,h)=>({ statusCode:200, headers:{...CORS, ...(h||{})}, body:JSON.stringify(b) });
const err = (s,b)=>({ statusCode:s, headers:CORS, body:JSON.stringify(b) });
const noc = ()=>({ statusCode:204, headers:CORS, body:"" });

/* ==== Admin init ==== */
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

const ipKey = ip => (ip||"unknown").replace(/[^\w]/g,"_").toLowerCase().slice(0,200);

exports.handler = async (event)=>{
  if (event.httpMethod === "OPTIONS") return noc();
  if (event.httpMethod !== "POST")    return err(405,{error:"Method Not Allowed"});
  try{
    const adminSDK = getAdmin();
    const h = event.headers || {};
    const raw = h["x-forwarded-for"] || h["X-Forwarded-For"] || "";
    const ip =
      h["x-nf-client-connection-ip"] || h["client-ip"] || h["x-real-ip"] ||
      (raw ? raw.split(",")[0].trim() : null) || "unknown";

    const auth = h.authorization || h.Authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return err(401,{error:"Missing Bearer token"});

    const dec = await adminSDK.auth().verifyIdToken(token, true);
    const uid = dec.uid;

    const db = adminSDK.firestore();
    const ts = adminSDK.firestore.Timestamp.now();
    const ua = h["user-agent"] || "unknown";
    const id = ipKey(ip);

    await db.runTransaction(async tx=>{
      const uRef = db.collection("users").doc(uid);
      const lgRef = uRef.collection("logins").doc();
      tx.set(lgRef, { ip, at: ts, ua, forwardedFor: raw||"" });
      tx.set(uRef,  { lastIP: ip, lastLogin: ts, lastUA: ua }, { merge:true });

      const ipRef = db.collection("ip_users").doc(id);
      tx.set(ipRef, {
        ip,
        lastSeen: ts,
        uids: adminSDK.firestore.FieldValue.arrayUnion(uid)
      }, { merge:true });

      const hitRef = ipRef.collection("hits").doc();
      tx.set(hitRef, { uid, at: ts, ua });
    });

    return ok({ ok:true, ip });
  }catch(e){
    console.error("save-login-ip", e);
    return err(500,{ok:false,error:e.message});
  }
};
