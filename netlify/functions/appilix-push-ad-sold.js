// netlify/functions/appilix-push-ad-sold.js
// ESM Netlify Function: Broadcast “Ads SOLD!” to all buyers of a given adId.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET'
};

let _adminInit = false;
let _firestore = null;

// Lazy init Firebase Admin using B64 service account
async function ensureAdmin() {
  if (_adminInit) return _firestore;
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 not set');

  const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));

  const { initializeApp, getApps, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');

  if (getApps().length === 0) {
    initializeApp({ credential: cert(json) });
  }
  _firestore = getFirestore();
  _adminInit = true;
  return _firestore;
}

async function sendAppilixPush({ user_identity, title, body, open_link_url, image_url }) {
  const APP_KEY = process.env.APPILIX_APP_KEY;
  const API_KEY = process.env.APPILIX_API_KEY;           // legacy
  const ACCOUNT_KEY = process.env.APPILIX_ACCOUNT_KEY;   // new

  if (!APP_KEY || (!API_KEY && !ACCOUNT_KEY)) {
    throw new Error('Appilix keys missing (APPILIX_APP_KEY + API/ACCOUNT key)');
  }

  const form = new URLSearchParams();
  form.set('app_key', APP_KEY);
  if (API_KEY) form.set('api_key', API_KEY);
  if (ACCOUNT_KEY) form.set('account_key', ACCOUNT_KEY);

  form.set('notification_title', title);
  form.set('notification_body', body);
  form.set('user_identity', user_identity);
  if (open_link_url) form.set('open_link_url', open_link_url);
  if (image_url) {
    form.set('notification_image', image_url);
    form.set('image_url', image_url);
  }

  const r = await fetch('https://appilix.com/api/push-notification', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Appilix ${r.status}: ${text}`);
  }
  return text;
}

async function getAdMeta(db, adId) {
  // Prefer deletedAds (tumne yahi bola tha), fallback items
  const del = await db.collection('deletedAds').doc(adId).get();
  if (del.exists) {
    const d = del.data() || {};
    return {
      title: d.title || 'Your ad',
      thumbnail: d.thumbnail || (Array.isArray(d.images) ? d.images[0] : '') || '',
      sellerId: d.ownerId || d.userId || d.postedBy || d.sellerId || null
    };
  }
  const it = await db.collection('items').doc(adId).get();
  if (it.exists) {
    const d = it.data() || {};
    return {
      title: d.title || 'Your ad',
      thumbnail: d.thumbnail || (Array.isArray(d.images) ? d.images[0] : '') || '',
      sellerId: d.ownerId || d.userId || d.postedBy || d.sellerId || null
    };
  }
  return { title: 'Your ad', thumbnail: '', sellerId: null };
}

async function getBuyersForAd(db, adId, sellerId) {
  // chats where productId/adId == adId
  const q1 = db.collection('chats').where('productId', '==', adId);
  const q2 = db.collection('chats').where('adId', '==', adId);

  const [s1, s2] = await Promise.all([q1.get().catch(()=>null), q2.get().catch(()=>null)]);
  const docs = [
    ...((s1 && s1.docs) || []),
    ...((s2 && s2.docs) || [])
  ];

  const uidSet = new Set();
  for (const doc of docs) {
    const c = doc.data() || {};
    if (Array.isArray(c.users)) c.users.forEach(u => { if (u) uidSet.add(u); });
    if (c.buyerId) uidSet.add(c.buyerId);
  }
  // remove seller if present
  if (sellerId) uidSet.delete(sellerId);
  return Array.from(uidSet);
}

async function identityForUid(db, uid) {
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return uid;
  const d = snap.data() || {};
  return (
    d.appilixIdentity ||
    (d.push && d.push.appilixIdentity) ||
    d.email ||
    d.username ||
    uid
  );
}

export default async (req) => {
  try {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (req.method === 'GET') {
      return new Response(
        JSON.stringify({ ok: true, hint: 'POST { adId, click_url? }' }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }
    if (req.method !== 'POST') {
      return new Response(
        JSON.stringify({ ok: false, error: 'Method not allowed' }),
        { status: 405, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    const { adId, click_url } = await req.json();
    if (!adId) {
      return new Response(
        JSON.stringify({ ok: false, error: 'adId required' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    const db = await ensureAdmin();

    // 1) pull meta (title + thumbnail)
    const { title, thumbnail, sellerId } = await getAdMeta(db, adId);

    // 2) list buyers
    const buyers = await getBuyersForAd(db, adId, sellerId);

    if (!buyers.length) {
      return new Response(
        JSON.stringify({ ok: true, sent: 0, buyers: [] }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    // 3) resolve identities
    const identities = await Promise.all(buyers.map(uid => identityForUid(db, uid)));

    // 4) push all (fire in parallel but don’t explode on one failure)
    const results = [];
    await Promise.all(identities.map(async (iden, idx) => {
      try {
        await sendAppilixPush({
          user_identity: iden,
          title: 'Ads SOLD!',
          body: title,
          open_link_url: click_url || `${new URL(req.url).origin}/chat-list.html`,
          image_url: thumbnail || undefined
        });
        results[idx] = { ok: true, identity: iden };
      } catch (e) {
        results[idx] = { ok: false, identity: iden, error: String(e) };
      }
    }));

    const sent = results.filter(r => r?.ok).length;

    return new Response(
      JSON.stringify({ ok: true, adId, title, thumbnail, buyers, identities, sent, results }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
};
