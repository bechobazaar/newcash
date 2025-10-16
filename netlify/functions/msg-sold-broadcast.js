// netlify/functions/msg-sold-broadcast.js
// Broadcast "Sold" push to EVERY user who messaged about this item.
// Safe from ad-blockers (no "ad/ads" in path).

const fetch = require('node-fetch');
const admin = require('firebase-admin');

/* ---------- Firebase Admin init (Base64 env friendly) ---------- */
function decodeB64(s){ try{ return Buffer.from(s||'', 'base64').toString('utf8'); }catch{ return ''; } }

function initAdmin(){
  if (admin.apps.length) return admin.app();

  // Prefer single env var: FIREBASE_SERVICE_ACCOUNT_B64
  const whole = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (whole){
    const json = JSON.parse(decodeB64(whole) || '{}');
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   json.project_id,
        clientEmail: json.client_email,
        privateKey:  (json.private_key || '').replace(/\\n/g, '\n')
      }),
      projectId: json.project_id
    });
    return admin.app();
  }

  // Fallback to individual Base64 vars (optional)
  const projectId   = decodeB64(process.env.FIREBASE_PROJECT_ID   || '').trim();
  const clientEmail = decodeB64(process.env.FIREBASE_CLIENT_EMAIL || '').trim();
  let   privateKey  = decodeB64(process.env.FIREBASE_PRIVATE_KEY  || '');
  if (privateKey) privateKey = privateKey.replace(/\\n/g, '\n');

  if (projectId && clientEmail && privateKey){
    admin.initializeApp({
      credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
      projectId
    });
  } else {
    // Local/emulator fallback (uses ADC if available)
    admin.initializeApp({});
  }
  return admin.app();
}

const db = initAdmin().firestore();

/* ---------- CORS ---------- */
const ALLOWED_ORIGINS = [
  'https://bechobazaar.com',
  'https://www.bechobazaar.com',
  'https://bechobazaar.netlify.app',
  'http://localhost:8888',
  'http://localhost:5173'
];
function corsHeaders(origin){
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : '*';
  return {
    'Access-Control-Allow-Origin':  allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age':       '86400',
    'Vary':                         'Origin'
  };
}

/* ---------- Small concurrency limiter ---------- */
function pLimit(n=10){
  const q=[]; let active=0;
  const next=()=>{ active--; if(q.length) q.shift()(); };
  return fn => (...args)=> new Promise((res,rej)=>{
    const run=()=>{ active++; Promise.resolve(fn(...args)).then(res,rej).finally(next); };
    (active<n) ? run() : q.push(run);
  });
}
const limit10 = pLimit(10);

/* ---------- Config ---------- */
const APPILIX_FN = process.env.APPILIX_FN_URL
  || 'https://bechobazaar.netlify.app/.netlify/functions/appilix-push';

/* ---------- Helper: collect all chat recipients for this item ---------- */
async function getAllRecipientsForItem(adId, sellerId){
  // Some code uses "itemId", some "productId", some "adId" – query them all.
  const fields = ['itemId', 'productId', 'adId'];
  const recipients = new Set();

  // Run queries in parallel
  const snaps = await Promise.all(
    fields.map(f => db.collection('chats').where(f, '==', adId).get().catch(()=>null))
  );

  snaps.filter(Boolean).forEach(snap=>{
    snap.forEach(doc=>{
      const d = doc.data() || {};
      const users = Array.isArray(d.users) ? d.users : [];
      users.forEach(u => { if (u && u !== sellerId) recipients.add(u); });
    });
  });

  return recipients;
}

/* ---------- Handler ---------- */
exports.handler = async (event) => {
  const origin  = event.headers?.origin || '';
  const headers = corsHeaders(origin);

  try{
    if (event.httpMethod === 'OPTIONS'){
      return { statusCode: 204, headers, body: '' };
    }
    if (event.httpMethod !== 'POST'){
      return { statusCode: 405, headers, body: 'Method Not Allowed' };
    }

    const { adId, sellerId, adTitle, thumb, deepLink, message } =
      JSON.parse(event.body || '{}') || {};

    if (!adId || !sellerId){
      return { statusCode: 400, headers, body: 'adId and sellerId are required' };
    }

    // 🔎 Find ALL users who chatted about this item (except seller)
    const recipients = await getAllRecipientsForItem(adId, sellerId);

    if (recipients.size === 0){
      return { statusCode: 200, headers, body: JSON.stringify({ ok:true, sent:0, reason:'no recipients' }) };
    }

    const title    = adTitle ? `Sold: ${adTitle}` : 'Ad was sold';
    const bodyText = message || 'Thanks for your interest! This item has been sold.';
    const payload  = {
      title,
      message: bodyText,
      body: bodyText,
      image_url: thumb || '',
      notification_image_url: thumb || '',
      open_link_url: deepLink || `https://bechobazaar.com/detail.html?id=${encodeURIComponent(adId)}`
    };

    // 🔔 Fan-out via Appilix (concurrency-limited)
    const jobs = [];
    for (const uid of recipients){
      jobs.push(limit10(async ()=>{
        const r   = await fetch(APPILIX_FN, {
          method:'POST',
          headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify({ user_identity: uid, ...payload })
        });
        const txt = await r.text();
        const ok  = r.ok && !/\"status\"\s*:\s*\"false\"/i.test(txt);
        if (!ok) console.warn('[sold-broadcast] push failed for', uid, txt);
        return ok;
      }));
    }

    const results = await Promise.all(jobs.map(j=>j()));
    const sent    = results.filter(Boolean).length;

    // (Optional) mark on items for analytics
    try{
      await db.collection('items').doc(adId).set(
        { soldBroadcastAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge:true }
      );
    }catch(_){}

    return { statusCode: 200, headers, body: JSON.stringify({ ok:true, total: recipients.size, sent }) };
  }catch(e){
    console.error('sold-broadcast error:', e);
    return { statusCode: 500, headers, body: 'Server error: ' + (e && e.message) };
  }
};
