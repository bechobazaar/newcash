const admin = require("firebase-admin");

let app;
function init() {
  if (!app) {
    app = admin.initializeApp({
      credential: admin.credential.cert({
        project_id: process.env.FIREBASE_PROJECT_ID,
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
    });
  }
}

exports.handler = async (event) => {
  try {
    init();

    // 🔑 Simple protection: केवल secret token से ही call allowed
    const authHeader = event.headers["x-admin-secret"];
    if (authHeader !== process.env.SET_ADMIN_SECRET) {
      return { statusCode: 403, body: "Forbidden" };
    }

    const body = JSON.parse(event.body || "{}");
    const email = body.email;
    if (!email) return { statusCode: 400, body: "Email required" };

    const user = await admin.auth().getUserByEmail(email);
    await admin.auth().setCustomUserClaims(user.uid, { admin: true });

    return {
      statusCode: 200,
      body: `OK: ${email} is now admin`,
    };
  } catch (e) {
    return { statusCode: 500, body: "Error: " + e.message };
  }
};
