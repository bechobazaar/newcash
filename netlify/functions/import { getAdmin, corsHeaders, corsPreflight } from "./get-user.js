import { getAdmin, corsHeaders, corsPreflight } from "./_admin.js";

export async function handler(event) {
  const pre = corsPreflight(event);
  if (pre) return pre;

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: corsHeaders(), body: "Method not allowed" };
  }

  try {
    const { db } = getAdmin();
    const { uid } = JSON.parse(event.body || "{}");
    if (!uid) {
      return { statusCode: 400, headers: corsHeaders(), body: "Missing uid" };
    }

    const snap = await db.collection("users").doc(uid).get();
    if (!snap.exists) {
      return { statusCode: 404, headers: corsHeaders(), body: "User not found" };
    }

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ id: snap.id, data: snap.data() })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: err.message })
    };
  }
}
