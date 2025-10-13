// netlify/functions/send-appilix-push.js
export async function handler(event) {
  const origin = event.headers?.origin || "https://bechobazaar.com";
  const cors = {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: cors, body: "Method not allowed" };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    let { user_identity, title, message, open_link_url, image_url } = body;

    // Required Appilix creds (set in Netlify env)
    const appKey = process.env.APPILIX_APP_KEY;
    const apiKey = process.env.APPILIX_API_KEY;
    if (!appKey || !apiKey) {
      return {
        statusCode: 500,
        headers: cors,
        body: JSON.stringify({ ok: false, error: "Missing Appilix keys (APPILIX_APP_KEY / APPILIX_API_KEY)" }),
      };
    }

    // Normalize open_link_url: default /account, make absolute if relative
    const SITE = "https://bechobazaar.com";
    const toAbs = (u) => {
      if (!u) return `${SITE}/account`;
      const s = String(u);
      if (s.startsWith("http://") || s.startsWith("https://")) return s;
      return s.startsWith("/") ? `${SITE}${s}` : `${SITE}/${s}`;
    };
    open_link_url = toAbs(open_link_url || "/account");

    // Build form for Appilix API
    const form = new URLSearchParams();
    form.set("app_key", appKey);
    form.set("api_key", apiKey);
    form.set("notification_title", title || "Notification");
    form.set("notification_body", message || "");
    form.set("open_link_url", open_link_url);
    if (user_identity) form.set("user_identity", user_identity); // targeted
    if (image_url) form.set("image_url", image_url);             // thumbnail (if Appilix supports)

    // Call Appilix
    const resp = await fetch("https://appilix.com/api/push-notification", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const text = await resp.text();
    let apiOk = resp.ok;
    // Try to parse {"status":"true"} or {"status":true}
    try {
      const j = JSON.parse(text);
      if (typeof j.status !== "undefined") {
        apiOk = (j.status === true || j.status === "true");
      }
    } catch {
      // fallback: look for "status":"true" in plain text
      if (/"status"\s*:\s*"true"/i.test(text)) apiOk = true;
      if (/"status"\s*:\s*"false"/i.test(text)) apiOk = false;
    }

    return {
      statusCode: apiOk ? 200 : 502,
      headers: cors,
      body: JSON.stringify({
        ok: apiOk,
        result: { httpStatus: resp.status, body: text },
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ ok: false, error: String(err?.message || err) }),
    };
  }
}
 
