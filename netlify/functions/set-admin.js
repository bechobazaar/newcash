// netlify/functions/set-admin.js
const admin = require('firebase-admin');

let initialized = false;
function init() {
  if (initialized) return;

  // 🔓 decode full JSON
  const jsonString = Buffer.from(
    process.env.FIREBASE_SERVICE_ACCOUNT_B64,
    'base64'
  ).toString('utf8');
  const serviceAccount = JSON.parse(jsonString);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  initialized = true;
}

exports.handler = async (event) => {
  try {
    init();
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
