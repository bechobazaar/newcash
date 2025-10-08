// netlify/functions/send-appilix-push.js
const fetch = require("node-fetch");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const APPILIX_URL = "https://appilix.com/api/push-notification";
const APP_KEY = process.env.APPILIX_APP_KEY;
const API_KEY = process.env.APPILIX_API_KEY;

const res = (statusCode, body) =>
  ({ statusCode, headers: CORS, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return res(204, {});
  try {
    const { user_identity, title, message, open_link_url } = JSON.parse(event.body || "{}");

    // 🔒 IMPORTANT: broadcast disable
    if (!user_identity) return res(400, { ok: false, error: "missing user_identity" });

    const form = new URLSearchParams();
    form.set("app_key", APP_KEY);
    form.set("api_key", API_KEY);
    form.set("user_identity", user_identity);
    form.set("notification_title", title || "Notification");
    form.set("notification_body", message || "");
    if (open_link_url) form.set("open_link_url", open_link_url);

    const r = await fetch(APPILIX_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const text = await r.text();
    return res(200, { ok: true, result: { status: r.status, text } });
  } catch (e) {
    return res(500, { ok: false, error: String(e) });
  }
};
