// netlify/functions/log-device.js
const admin = require('firebase-admin');

function getServiceAccount() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!b64) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_BASE64 env var');
  try {
    const json = Buffer.from(b64, 'base64').toString();
    return JSON.parse(json);
  } catch (e) {
    // maybe it's raw JSON (not base64)
    try { return JSON.parse(b64); } catch (ee) { throw e; }
  }
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(getServiceAccount()),
  });
}
const db = admin.firestore();

async function detectIp(event) {
  const headers = event.headers || {};
  // Netlify sets x-nf-client-connection-ip for client IP. Also check x-forwarded-for
  const ip =
    headers['x-nf-client-connection-ip'] ||
    (headers['x-forwarded-for'] ? headers['x-forwarded-for'].split(',')[0].trim() : null) ||
    headers['x-real-ip'] ||
    (event.requestContext && event.requestContext.identity && event.requestContext.identity.sourceIp) ||
    'unknown';
  return ip;
}

exports.handler = async (event) => {
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    const incomingIdToken = body.idToken || null; // optional: prefer verifying
    let uid = body.userId || null;
    const deviceId = body.deviceId || body.deviceToken || null; // required ideally
    const fingerprint = body.fingerprint || {};
    const meta = body.meta || {};

    if (!deviceId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'deviceId_required' }) };
    }

    // Verify idToken if provided (preferred for security)
    if (incomingIdToken) {
      try {
        const decoded = await admin.auth().verifyIdToken(incomingIdToken);
        uid = decoded.uid;
      } catch (e) {
        console.warn('invalid idToken', e.message);
        // continue: may still accept userId supplied by client (less secure)
      }
    }

    const ip = await detectIp(event);
    const ua = (event.headers && (event.headers['user-agent'] || event.headers['User-Agent'])) || '';

    const now = admin.firestore.FieldValue.serverTimestamp();

    // Upsert device doc under users/{uid}/devices/{deviceId} if uid present
    if (uid) {
      const userDevRef = db.collection('users').doc(uid).collection('devices').doc(deviceId);
      await userDevRef.set({
        deviceId,
        fingerprint,
        meta,
        ipLastSeen: ip,
        ua,
        lastSeenAt: now,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } else {
      // store in anonymous_devices so you can later map if user claims it
      await db.collection('anonymous_devices').doc(deviceId).set({
        deviceId,
        fingerprint,
        meta,
        ipLastSeen: ip,
        ua,
        lastSeenAt: now,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    // Now: maintain a reverse mapping deviceId -> set of userIds (for quick detection)
    // Use transaction to atomically update list and set flagged true if >1 distinct user
    const abuseRef = db.collection('abuse').doc('devices').collection('list').doc(deviceId);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(abuseRef);
      let data = snap.exists ? snap.data() : { userIds: [], ips: [], uaSamples: [] };
      const uids = new Set(Array.isArray(data.userIds) ? data.userIds : []);
      if (uid) uids.add(uid);

      const ips = new Set(Array.isArray(data.ips) ? data.ips : []);
      if (ip && ip !== 'unknown') ips.add(ip);

      const uas = Array.isArray(data.uaSamples) ? data.uaSamples : [];
      if (ua && !uas.includes(ua)) {
        uas.unshift(ua);
        if (uas.length > 5) uas.length = 5;
      }

      const updated = {
        deviceId,
        userIds: Array.from(uids),
        ips: Array.from(ips),
        uaSamples: uas,
        lastUpdated: now,
      };

      // flagged if same device used by >1 distinct user accounts
      updated.flagged = updated.userIds.length > 1;

      tx.set(abuseRef, updated, { merge: true });

      // Optionally: also write a top-level quick flag doc for UI convenience
      const flaggedRef = db.collection('abuse').doc('flags').collection('byDevice').doc(deviceId);
      if (updated.flagged) {
        tx.set(flaggedRef, { deviceId, userIds: updated.userIds, ips: updated.ips, lastUpdated: now }, { merge: true });
      } else {
        // if previously flagged but now single user, remove flagged doc
        tx.delete(flaggedRef).catch(()=>{});
      }
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, ip, deviceId }) };
  } catch (err) {
    console.error('log-device err', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'server_error', details: err.message }) };
  }
};
