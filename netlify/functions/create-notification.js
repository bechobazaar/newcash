// /.netlify/functions/create-notification.js
// Node 18+ (Netlify). Saves to Firestore + sends SAME message via FCM data-only push.

const admin = require('firebase-admin');

function initAdmin() {
  if (!admin.apps.length) {
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    const obj = JSON.parse(Buffer.from(b64.trim(), 'base64').toString('utf8'));
    if (obj.private_key) obj.private_key = obj.private_key.replace(/\\n/g, '\n');
    admin.initializeApp({ credential: admin.credential.cert(obj) });
  }
}
const parseCSV = s => String(s||'').split(',').map(v=>v.trim()).filter(Boolean);
function pickOrigin(event) {
  const allowed = parseCSV(process.env.ALLOWED_ORIGINS);
  const h = event.headers || {};
  const o = h.origin || h.Origin || (h.host ? `https://${h.host}` : '');
  const base = (process.env.APP_BASE_URL || '').replace(/\/$/,'');
  return allowed.includes(o) ? o : (base || allowed[0] || '*');
}
async function ensureAuth(event) {
  const adminKey = process.env.ADMIN_PUSH_KEY || process.env.ADMIN_PUSH_SECRET;
  const s = (event.headers||{})['x-admin-secret'];
  if (adminKey && s === adminKey) return { mode:'admin' };
  const auth = (event.headers.authorization || event.headers.Authorization || '');
  if (!auth.startsWith('Bearer ')) { const e=new Error('Unauthorized'); e.code=401; throw e; }
  const decoded = await admin.auth().verifyIdToken(auth.slice(7));
  return { mode:'user', uid:decoded.uid, email:decoded.email };
}
const json = (h, code, obj) => ({ statusCode:code, headers:{...h,'Content-Type':'application/json'}, body:JSON.stringify(obj) });

exports.handler = async (event) => {
  initAdmin();
  const db = admin.firestore();
  const ORIGIN = pickOrigin(event);
  const cors = {
    'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode:204, headers:cors, body:'' };
  if (event.httpMethod !== 'POST')   return json(cors,405,{error:'Method Not Allowed'});

  try {
    await ensureAuth(event);

    let b; try { b = JSON.parse(event.body||'{}'); } catch { return json(cors,400,{error:'Invalid JSON'}); }
    const userId = String(b.userId || b.uid || '');
    const message = String(b.message || '').trim();
    const type = String(b.type || 'info').toLowerCase();
    if (!userId || !message) return json(cors,400,{error:'userId and message required'});

    const titleOverride = b.title ? String(b.title) : null;
    const adId = b.adId ? String(b.adId) : undefined;
    const urlOverride = b.url ? String(b.url) : null;

    // 1) Save Firestore doc (idempotent if b.id provided)
    const notifRef = (b.id ? db.collection('notifications').doc(String(b.id)) : db.collection('notifications').doc());
    const notifId = notifRef.id;
    const notifData = {
      userId, message, type, adId,
      adminName: b.adminName || undefined,
      imageUrl:  b.imageUrl  || undefined,
      reason:    b.reason    || undefined,
      seen:false,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };
    await notifRef.set(notifData, { merge:true });

    // 2) Build push content (same message)
    let title = titleOverride || 'New at Bechobazaar';
    if (!titleOverride) {
      if (type === 'approved') title = 'Ad approved';
      else if (type === 'rejected') title = 'Ad rejected';
      else if (type === 'warning')  title = 'Important update';
    }
    const base = (process.env.APP_BASE_URL || 'https://bechobazaar.com').replace(/\/$/,'');
    let url = urlOverride || '/notifications.html';
    if (!urlOverride && adId) url = `/seller-uploads.html?ad=${encodeURIComponent(adId)}`;
    const link = /^https?:\/\//.test(url) ? url : `${base}${url.startsWith('/')?'':'/'}${url}`;
    const tag = adId ? `ad_${adId}` : `notif_${notifId}`;

    // 3) Collect tokens (legacy + unified) & de-dupe
    const tokensSet = new Set();
    const legacy = await db.collection('users').doc(userId).collection('fcmTokens').get();
    legacy.forEach(d => d.id && tokensSet.add(d.id));
    const pe = await db.collection('users').doc(userId).collection('pushEndpoints').get();
    pe.forEach(d => { const x=d.data()||{}; if ((x.type==='fcm_web'||x.type==='native') && x.token) tokensSet.add(x.token); });
    const tokens = Array.from(tokensSet);
    if (!tokens.length) {
      await notifRef.set({ pushSent:false, pushReason:'no_tokens' }, { merge:true });
      return json(cors,200,{ notifId, sent:0, failed:0, reason:'no_tokens' });
    }

    // 4) DATA-ONLY FCM (no `notification` → no Chrome duplicate)
    const payload = {
      data: { title:String(title), body:String(message), url:link, tag:String(tag), ch:'fcm', kind:'system', notifId:String(notifId) },
      webpush: { fcmOptions:{ link }, headers:{ Urgency:'high', TTL:'600' } },
      android: { priority:'high' },
      apns: { headers:{ 'apns-priority':'10' } }
    };

    let success=0, failed=0;
    for (let i=0; i<tokens.length; i+=500) {
      const slice = tokens.slice(i, i+500);
      const res = await admin.messaging().sendEachForMulticast({ tokens:slice, ...payload });
      success += res.successCount; failed += res.failureCount;
      // cleanup invalid tokens
      for (let j=0;j<res.responses.length;j++){
        const r = res.responses[j];
        if (!r.success) {
          const code = r.error?.code || '';
          if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
            const bad = slice[j];
            try {
              await db.collection('users').doc(userId).collection('fcmTokens').doc(bad).delete().catch(()=>{});
              const qs = await db.collection('users').doc(userId).collection('pushEndpoints').where('token','==',bad).get();
              qs.forEach(d=>d.ref.delete().catch(()=>{}));
            } catch {}
          }
        }
      }
    }

    await notifRef.set({ pushSent:true, pushStats:{ sent:success, failed }, pushedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge:true });
    return json(cors,200,{ notifId, sent:success, failed });
  } catch (e) {
    const code = e.code===401?401 : e.code===403?403 : 500;
    console.error('create-notification error', e);
    return json(cors, code, { error: code===500 ? 'Internal Server Error' : e.message });
  }
};
