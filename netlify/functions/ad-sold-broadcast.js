// netlify/functions/ad-sold-broadcast.js
// Broadcasts "Ad was sold" push to everyone who messaged the seller about this ad.

const fetch = require('node-fetch');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp({});
const db = admin.firestore();

function pLimit(limit=10){
  const q=[]; let active=0;
  const next=()=>{ active--; if(q.length) q.shift()(); };
  return fn => (...args)=> new Promise((res,rej)=>{
    const run=()=>{ active++; Promise.resolve(fn(...args)).then(res,rej).finally(next); };
    (active<limit) ? run() : q.push(run);
  });
}
const limit10 = pLimit(10);

// Your existing Appilix wrapper function URL:
const APPILIX_FN = process.env.APPILIX_FN_URL
  || 'https://bechobazaar.netlify.app/.netlify/functions/appilix-push';

exports.handler = async (event) => {
  try{
    if(event.httpMethod!=='POST') return { statusCode:405, body:'Method Not Allowed' };
    const { adId, sellerId, adTitle, thumb, deepLink, message } = JSON.parse(event.body||'{}')||{};
    if(!adId || !sellerId) return { statusCode:400, body:'adId and sellerId are required' };

    // Find all chat threads tied to this ad
    // NOTE: If your field is adId/productId, change 'itemId' below accordingly.
    const chatsSnap = await db.collection('chats').where('itemId', '==', adId).get();
    const recipients = new Set();
    chatsSnap.forEach(doc=>{
      const data=doc.data()||{};
      const users = Array.isArray(data.users) ? data.users : [];
      users.forEach(u => { if(u && u!==sellerId) recipients.add(u); });
    });

    if(recipients.size===0){
      return { statusCode:200, body: JSON.stringify({ ok:true, sent:0, reason:'no recipients' }) };
    }

    const title = adTitle ? `Sold: ${adTitle}` : 'Ad was sold';
    const bodyText = message || 'Thanks for your interest! This item has been sold.';
    const payload = {
      title,
      message: bodyText,
      body: bodyText,
      image_url: thumb || '',
      notification_image_url: thumb || '',
      open_link_url: deepLink || `https://bechobazaar.com/detail.html?id=${encodeURIComponent(adId)}`
    };

    const jobs = [];
    for(const uid of recipients){
      jobs.push(limit10(async ()=>{
        const r = await fetch(APPILIX_FN, {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ user_identity: uid, ...payload })
        });
        const txt = await r.text();
        const ok = r.ok && !/\"status\"\s*:\s*\"false\"/i.test(txt);
        if(!ok) console.warn('Push failed for', uid, txt);
        return ok;
      }));
    }

    const results = await Promise.all(jobs.map(j=>j()));
    const sent = results.filter(Boolean).length;

    // optional marker on the ad
    try{
      await db.collection('items').doc(adId).set(
        { soldBroadcastAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge:true }
      );
    }catch(_){}

    return { statusCode:200, body: JSON.stringify({ ok:true, total: recipients.size, sent }) };
  }catch(e){
    console.error(e);
    return { statusCode:500, body:'Server error: '+(e&&e.message) };
  }
};
