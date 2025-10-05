// netlify/functions/_admin-utils.js
const admin = require('firebase-admin');

function initAdmin() {
  if (admin.apps.length) return admin;

  // Service account creds:
  //  - Netlify env var: FIREBASE_SERVICE_ACCOUNT (JSON string)
  //  - ya GOOGLE_APPLICATION_CREDENTIALS se default creds
  let creds = null;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try { creds = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); } catch {}
  }

  admin.initializeApp({
    credential: creds
      ? admin.credential.cert(creds)
      : admin.credential.applicationDefault(),
  });
  return admin;
}

// Verify ID token and require custom claim admin === true
async function requireAdmin(event) {
  const hdr = event.headers.authorization || '';
  const idToken = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!idToken) return { ok: false, status: 401, msg: 'Missing Authorization' };

  const admin = initAdmin();
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(idToken); }
  catch { return { ok:false, status:401, msg:'Invalid token' }; }

  if (!decoded?.admin) return { ok:false, status:403, msg:'Not admin' };
  return { ok:true, admin, decoded };
}

module.exports = { initAdmin, requireAdmin };
