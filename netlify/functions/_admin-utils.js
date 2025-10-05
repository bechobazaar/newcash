// netlify/functions/_admin-utils.js
const admin = require('firebase-admin');

function initAdmin() {
  if (admin.apps.length) return admin;

  // OPTION A: GOOGLE_APPLICATION_CREDENTIALS (service account JSON file)
  // OPTION B: NETLIFY ENV VAR "FIREBASE_SERVICE_ACCOUNT" (JSON string)
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

// Verify ID token + assert custom claim admin === true
async function requireAdmin(req) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!token) return { ok:false, status:401, msg:'Missing Authorization token' };

  const admin = initAdmin();
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(token); }
  catch { return { ok:false, status:401, msg:'Invalid token' } }

  if (!decoded || !decoded.admin) return { ok:false, status:403, msg:'Not admin' };
  return { ok:true, admin, uid: decoded.uid, decoded };
}

module.exports = { initAdmin, requireAdmin };
