// netlify/functions/firebaseAdmin.js
const admin = require('firebase-admin');

function initAdminFromB64() {
  if (admin.apps.length) return admin;

  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) {
    console.warn('[ADMIN] FIREBASE_SERVICE_ACCOUNT_B64 missing. Using default creds (may fail on Netlify).');
    admin.initializeApp({});
    return admin;
  }

  let jsonStr;
  try {
    jsonStr = Buffer.from(b64, 'base64').toString('utf8');
  } catch (e) {
    console.error('[ADMIN] base64 decode failed:', e);
    admin.initializeApp({});
    return admin;
  }

  let sa;
  try {
    sa = JSON.parse(jsonStr);
  } catch (e) {
    console.error('[ADMIN] JSON parse failed:', e);
    admin.initializeApp({});
    return admin;
  }

  // Ensure required fields exist
  const { project_id, client_email, private_key } = sa;
  if (!project_id || !client_email || !private_key) {
    console.error('[ADMIN] service account missing fields (project_id/client_email/private_key)');
    admin.initializeApp({});
    return admin;
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: project_id,
      clientEmail: client_email,
      // If private_key has literal "\n", admin SDK handles it — but normalize anyway
      privateKey: private_key.includes('\\n') ? private_key.replace(/\\n/g, '\n') : private_key,
    }),
    projectId: project_id,
  });

  return admin;
}

module.exports = { initAdminFromB64 };
