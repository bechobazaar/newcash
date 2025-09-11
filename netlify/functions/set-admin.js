// netlify/functions/set-admin.js
const admin = require('firebase-admin');

let initialized = false;
function init() {
  if (initialized) return;
  // 🔓 decode base64 private key
  const privateKeyDecoded = Buffer.from(
    process.env.FIREBASE_PRIVATE_KEY_B64,
    'base64'
  ).toString('utf8'); // अब असली multi-line key मिल गई

  admin.initializeApp({
    credential: admin.credential.cert({
      project_id: process.env.FIREBASE_PROJECT_ID,
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      private_key: privateKeyDecoded,   // NOTE: replace() की जरूरत नहीं
    }),
  });
  initialized = true;
}

exports.handler = async (event) => {
  try {
    init();
    // simple protection
    if (event.headers['x-admin-secret'] !== process.env.SET_ADMIN_SECRET) {
      return { statusCode: 403, body: 'Forbidden' };
    }

    const { email } = JSON.parse(event.body || '{}');
    if (!email) return { statusCode: 400, body: 'Email required' };

    const user = await admin.auth().getUserByEmail(email);
    await admin.auth().setCustomUserClaims(user.uid, { admin: true });
    return { statusCode: 200, body: `OK: ${email} is now admin` };
  } catch (e) {
    return { statusCode: 500, body: 'Error: ' + e.message };
  }
};
