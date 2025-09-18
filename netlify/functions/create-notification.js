// /.netlify/functions/create-notification.js
// Node 18+ (Netlify default). Sends phone push the moment a notification is saved.

const admin = require('firebase-admin');

function initAdmin() {
  if (!admin.apps.length) {
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    const obj = JSON.parse(Buffer.from(b64.trim(), 'base64').toString('utf8'));
    if (obj.private_key) obj.private_key = obj.private_key.replace(/\\n/g, '\n');
    admin.initializeApp({ credential: admin.credential.cert(obj) });
  }
}
const parseCSV = s => String(s || '').split(',').map(v => v.trim()).filter(Boolean);

function pickOrigin(event) {
  const allowed = parseCSV(process.env.ALLOWED_ORIGINS);
  const h = event.headers || {};
  const o = h.origin || h.Origin || (h.host ? `https://${h.host}` : '');
  const base = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  return allowed.includes(o) ? o : (base || allowed[0] || '*');
}

async function ensureAuth(event) {
  const adminKey = process.env.ADMIN_PUSH_KEY || process.env.ADMIN_PUSH_SECRET;
  const s = (event.headers || {})['x-admin-secret'];
  if (adminKey && s === adminKey) return { mode: 'admin' };

  const auth = (event.headers.authorization || event.headers.Authorization || '');
  if (!auth.startsWith('Bearer ')) {
    const err = new Error('Unauthorized'); err.code = 401; throw err;
  }
  const decoded = await admin.auth().verifyIdToken(auth.slice(7));
  return { mode: 'user', uid: decoded.uid, email: decoded.email };
}

function json(headers, statusCode, obj) {
  return { statusCode, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  initAdmin();
  const db = admin.firestore();

  const ORIGIN = pickOrigin(event);
  const cors = {
    'Access-Control-Allow-Origin': ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return json(cors, 405, { error: 'Method Not Allowed' });

  try {
    await ensureAuth(event);

    let b;
    try { b = JSON.parse(event.body || '{}'); }
    catch { return json(cors, 400, { error: 'Invalid JSON' }); }

    // Accept both userId / uid
    const userId = String(b.userId || b.uid || '');
    const message = String(b.message || '').trim();
    const type    = String(b.type || 'info').toLowerCase();

    if (!userId || !message) {
      return json(cors, 400, { error: 'userId and message required' });
    }

    // Optional overrides
    const titleOverride = b.title ? String(b.title) : null;
    const adId          = b.adId ? String(b.adId) : undefined;
    const urlOverride   = b.url ? String(b.url) : null;

    // ---- 1) Create Firestore doc (idempotent support via clientProvidedId) ----
    // If client passes 'id', we use it; avoids duplicates on retries
    const notifDocId = (b.id && String(b.id)) || null;
    const notifRef = notifDocId
      ? db.collection('notifications').doc(notifDocId)
      : db.collection('notifications').doc();

    const notifData = {
      userId,
      message,
      type,               // 'approved' | 'rejected' | 'info' | ...
      adId,
      adminName: b.adminName || undefined,
      imageUrl:  b.imageUrl  || undefined,
      reason:    b.reason    || undefined,
      seen: false,
      // only set timestamp if not exists (idempotent)
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };

    if (notifDocId) {
      // merge without overwriting existing message on accidental repeat
      await notifRef.set({ ...notifData }, { merge: true });
    } else {
      await notifRef.set(notifData);
    }
    const notifId = notifRef.id;

    // ---- 2) Title + link (type mapping; override if provided) ----
    let title = titleOverride || 'New at Bechobazaar';
    if (!titleOverride) {
      if (type === 'approved') title = 'Ad approved';
      else if (type === 'rejected') title = 'Ad rejected';
      else if (type === 'warning')  title = 'Important update';
    }

    const base = (process.env.APP_BASE_URL || 'https://bechobazaar.com').replace(/\/$/, '');
    let url = urlOverride || '/notifications.html';
    if (!urlOverride && adId) url = `/seller-uploads.html?ad=${encodeURIComponent(adId)}`;
    const link = /^https?:\/\//.test(url) ? url : `${base}${url.startsWith('/') ? '' : '/'}${url}`;

    // Collapse tag so repeated updates stack neatly
    const tag = adId ? `ad_${adId}` : `notif_${notifId}`;

    // ---- 3) Collect tokens (legacy + unified) & de-dupe ----
    const tokensSet = new Set();

    const legacy = await db.collection('users').doc(userId).collection('fcmTokens').get();
    legacy.forEach(d => d.id && tokensSet.add(d.id));

    // unified store
    const peSnap = await db.collection('users').doc(userId).collection('pushEndpoints').get();
    peSnap.forEach(d => {
      const x = d.data() || {};
      if ((x.type === 'fcm_web' || x.type === 'native') && x.token) tokensSet.add(x.token);
    });

    const tokens = Array.from(tokensSet);
    if (!tokens.length) {
      await notifRef.set({ pushSent: false, pushReason: 'no_tokens' }, { merge: true });
      return json(cors, 200, { notifId, sent: 0, failed: 0, reason: 'no_tokens' });
    }

    // ---- 4) DATA-ONLY FCM (avoid Chrome auto-card), batched by 500 ----
    const fcmPayloadBase = {
      data: {
        title: String(title),
        body:  String(message), // EXACT same as Firestore saved
        url:   link,
        tag:   String(tag),
        ch:    'fcm',           // channel marker (SW guard friendly)
        kind:  'system',
        notifId: String(notifId)
      },
      webpush: { fcmOptions: { link }, headers: { Urgency: 'high', TTL: '600' } },
      android: { priority: 'high' },
      apns:    { headers: { 'apns-priority': '10' } }
    };

    let success = 0, failed = 0;
    for (let i = 0; i < tokens.length; i += 500) {
      const batchTokens = tokens.slice(i, i + 500);
      const res = await admin.messaging().sendEachForMulticast({ tokens: batchTokens, ...fcmPayloadBase });
      success += res.successCount; failed += res.failureCount;

      // Cleanup invalids (both stores)
      for (let j = 0; j < res.responses.length; j++) {
        const r = res.responses[j];
        if (!r.success) {
          const code = r.error?.code || '';
          if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
            const bad = batchTokens[j];
            try {
              await db.collection('users').doc(userId).collection('fcmTokens').doc(bad).delete().catch(() => {});
              const qs = await db.collection('users').doc(userId).collection('pushEndpoints').where('token', '==', bad).get();
              qs.forEach(d => d.ref.delete().catch(() => {}));
            } catch {}
          }
        }
      }
    }

    // ---- 5) Mark doc for observability ----
    await notifRef.set({
      pushSent: true,
      pushStats: { sent: success, failed },
      pushedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return json(cors, 200, { notifId, sent: success, failed });
  } catch (e) {
    const code = e.code === 401 ? 401 : e.code === 403 ? 403 : 500;
    console.error('create-notification error', e);
    return json(cors, code, { error: code === 500 ? 'Internal Server Error' : e.message });
  }
};
