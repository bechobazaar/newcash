// netlify/functions/log-device.js
// -------------------------------
// Logs a device on login and maintains abuse indices:
//  - users/{uid}/devices/{deviceId}
//  - abuse/devices/list/{deviceId} (+ flags/byDevice/{deviceId} when multiple UIDs)
//  - abuse/ipIndex/ips/{ip}  (reverse IP -> UIDs for "Same-IP" tab)
//
// CORS-safe, secure (idToken verify), resilient to header variants.

const admin = require('firebase-admin');

// ---------- Config / Helpers ----------
function getServiceAccount() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!b64) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_BASE64 env var');
  try {
    // prefer base64
    const json = Buffer.from(b64, 'base64').toString();
    return JSON.parse(json);
  } catch {
    // maybe raw json
    return JSON.parse(b64);
  }
}

if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(getServiceAccount()) });
}
const db = admin.firestore();

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Content-Type': 'application/json; charset=utf-8',
};

const respond = (statusCode, obj) => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(obj),
});

function safeParseJSON(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function normalizeIp(ip) {
  if (!ip) return 'unknown';
  // Strip IPv6-mapped IPv4: ::ffff:1.2.3.4
  const m = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (m) return m[1];
  return ip.trim();
}

function header(h, key) {
  if (!h) return undefined;
  const v = h[key] ?? h[key?.toLowerCase?.()] ?? h[key?.toUpperCase?.()];
  return v;
}

async function detectIp(event) {
  const h = event.headers || {};
  const xnf = header(h, 'x-nf-client-connection-ip');
  const xff = header(h, 'x-forwarded-for');
  const xri = header(h, 'x-real-ip');
  const cfi = header(h, 'cf-connecting-ip'); // just in case
  const ctxIp = event.requestContext?.identity?.sourceIp;

  let ip =
    xnf ||
    (xff ? xff.split(',')[0].trim() : '') ||
    xri ||
    cfi ||
    ctxIp ||
    '';

  ip = normalizeIp(ip);
  return ip || 'unknown';
}

function trimLen(str, max = 400) {
  if (!str) return '';
  const s = String(str);
  return s.length > max ? s.slice(0, max) : s;
}

// ---------- Handler ----------
exports.handler = async (event) => {
  try {
    // Preflight
    if (event.httpMethod === 'OPTIONS') {
      return { statusCode: 204, headers: CORS_HEADERS, body: '' };
    }
    if (event.httpMethod !== 'POST') {
      return respond(405, { error: 'method_not_allowed' });
    }

    const body = safeParseJSON(event.body);
    if (!body) return respond(400, { error: 'invalid_json' });

    const incomingIdToken = body.idToken || null;
    let uid = body.userId || null;

    // Prefer secure verify
    if (incomingIdToken) {
      try {
        const decoded = await admin.auth().verifyIdToken(incomingIdToken);
        uid = decoded.uid;
      } catch (e) {
        // Continue but mark weaker trust
        console.warn('idToken verify failed:', e.message);
      }
    }
    if (!uid) {
      // We allow anonymous device index but best is with uid
      // If you want to hard-require auth, uncomment next line:
      // return respond(401, { error: 'auth_required' });
    }

    const deviceIdRaw = body.deviceId || body.deviceToken || '';
    const deviceId = trimLen(String(deviceIdRaw || '').replace(/\s+/g, ''), 200);
    if (!deviceId) return respond(400, { error: 'deviceId_required' });

    const fingerprint = body.fingerprint && typeof body.fingerprint === 'object' ? body.fingerprint : {};
    const meta = body.meta && typeof body.meta === 'object' ? body.meta : {};

    const ip = await detectIp(event);
    const ua = trimLen(header(event.headers, 'user-agent') || header(event.headers, 'User-Agent') || '', 400);
    const nowTS = admin.firestore.FieldValue.serverTimestamp();

    // --- Write user device doc OR anonymous device
    if (uid) {
      const userRef = db.collection('users').doc(uid);
      const userDevRef = userRef.collection('devices').doc(deviceId);
      await userDevRef.set(
        {
          deviceId,
          fingerprint,
          meta,
          ipLastSeen: ip,
          ua,
          lastSeenAt: nowTS,
          createdAt: nowTS,
        },
        { merge: true }
      );

      // Optional: keep quick pivots on user root (useful for "Scan lastIP (users)" mode)
      await userRef.set(
        {
          lastIP: ip,
          lastUA: ua,
          lastLoginAt: nowTS,
        },
        { merge: true }
      );
    } else {
      await db.collection('anonymous_devices').doc(deviceId).set(
        {
          deviceId,
          fingerprint,
          meta,
          ipLastSeen: ip,
          ua,
          lastSeenAt: nowTS,
          createdAt: nowTS,
        },
        { merge: true }
      );
    }

    // --- Reverse mapping: deviceId -> userIds (flag if multiple)
    const devIdxRef = db.collection('abuse').doc('devices').collection('list').doc(deviceId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(devIdxRef);
      let data = snap.exists ? snap.data() : { userIds: [], ips: [], uaSamples: [] };

      const users = new Set(Array.isArray(data.userIds) ? data.userIds : []);
      if (uid) users.add(uid);

      const ips = new Set(Array.isArray(data.ips) ? data.ips : []);
      if (ip && ip !== 'unknown') ips.add(ip);

      const uas = Array.isArray(data.uaSamples) ? data.uaSamples : [];
      if (ua && !uas.includes(ua)) {
        uas.unshift(ua);
        if (uas.length > 5) uas.length = 5;
      }

      const updated = {
        deviceId,
        userIds: Array.from(users),
        ips: Array.from(ips),
        uaSamples: uas,
        lastUpdated: nowTS,
      };
      updated.flagged = updated.userIds.length > 1;

      tx.set(devIdxRef, updated, { merge: true });

      // Quick flag doc for Admin UI convenience
      const flagRef = db.collection('abuse').doc('flags').collection('byDevice').doc(deviceId);
      if (updated.flagged) {
        tx.set(
          flagRef,
          { deviceId, userIds: updated.userIds, ips: updated.ips, lastUpdated: nowTS },
          { merge: true }
        );
      } else {
        // If previously flagged, clear it
        tx.delete(flagRef).catch(() => {});
      }
    });

    // --- Reverse IP index: ip -> userIds (for Same-IP tab)
    if (ip && ip !== 'unknown') {
      const ipRef = db.collection('abuse').doc('ipIndex').collection('ips').doc(ip);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ipRef);
        let data = snap.exists ? snap.data() : { userIds: [], uaSamples: [] };

        const users = new Set(Array.isArray(data.userIds) ? data.userIds : []);
        if (uid) users.add(uid);

        const uas = Array.isArray(data.uaSamples) ? data.uaSamples : [];
        if (ua && !uas.includes(ua)) {
          uas.unshift(ua);
          if (uas.length > 5) uas.length = 5;
        }

        tx.set(
          ipRef,
          {
            userIds: Array.from(users),
            uaSamples: uas,
            count: Array.from(users).length,
            lastSeen: nowTS,
          },
          { merge: true }
        );
      });
    }

    // Success
    return respond(200, {
      ok: true,
      deviceId,
      ip,
      trust: incomingIdToken ? 'verified' : (uid ? 'unverified_uid' : 'anonymous'),
    });
  } catch (err) {
    console.error('log-device error:', err);
    return respond(500, { error: 'server_error', details: err.message });
  }
};
