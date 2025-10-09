// (A) Broadcast push (no user_identity) OR segment wise (your own filter upstream)
exports.handler = async (event) => {
  try {
    const { APPILIX_APP_KEY, APPILIX_API_KEY, ALLOW_ORIGINS } = process.env;
    if (!APPILIX_APP_KEY || !APPILIX_API_KEY) {
      return { statusCode: 500, body: "Missing APPILIX keys" };
    }

    const origin = (event.headers.origin || "").toLowerCase();
    const allow = (ALLOW_ORIGINS || "").split(",").map(s => s.trim().toLowerCase());
    const cors =
      allow.length && allow.includes(origin)
        ? { "Access-Control-Allow-Origin": origin }
        : { "Access-Control-Allow-Origin": "*" };

    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: { ...cors, "Access-Control-Allow-Headers": "Content-Type,Authorization" } };
    }

    const { title, body, open_link_url } = JSON.parse(event.body || "{}");
    if (!title || !body) return { statusCode: 400, body: "title and body required" };

    const form = new URLSearchParams();
    form.set("app_key", APPILIX_APP_KEY);
    form.set("api_key", APPILIX_API_KEY);
    form.set("notification_title", title);
    form.set("notification_body", body);
    if (open_link_url) form.set("open_link_url", open_link_url);

    const res = await fetch("https://appilix.com/api/push-notification", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    const data = await res.text();

    return { statusCode: 200, headers: cors, body: data };
  } catch (e) {
    return { statusCode: 500, body: e.message };
  }
};
