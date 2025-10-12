// netlify/functions/_admin.js
import admin from "firebase-admin";

let inited = false;

export function getAdmin() {
  if (!inited) {
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!b64) throw new Error("FIREBASE_SERVICE_ACCOUNT env missing");
    const jsonStr = Buffer.from(b64, "base64").toString("utf8");
    const svc = JSON.parse(jsonStr);

    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.cert(svc),
        projectId: svc.project_id
      });
    }
    inited = true;
  }
  return { admin, db: admin.firestore() };
}

export function corsHeaders(origin = "*") {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };
}
export function corsPreflight(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(event.headers.origin || "*"), body: "" };
  }
  return null;
}
