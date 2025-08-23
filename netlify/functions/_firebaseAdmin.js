// netlify/functions/_firebaseAdmin.js
import admin from "firebase-admin";

let app;

export function getFirestore() {
  if (!app) {
    const projectId   = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const keyB64      = process.env.FIREBASE_PRIVATE_KEY_BASE64;

    if (!projectId || !clientEmail || !keyB64) {
      throw new Error("Firebase Admin env vars missing");
    }

    // decode private key
    const privateKey = Buffer.from(keyB64, "base64").toString("utf8");

    app = admin.apps.length
      ? admin.app()
      : admin.initializeApp({
          credential: admin.credential.cert({
            projectId,
            clientEmail,
            privateKey,
          }),
        });
  }
  return admin.firestore();
}

export { admin };
