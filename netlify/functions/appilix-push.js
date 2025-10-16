// netlify/functions/appilix-push.js
// Next-gen Netlify Functions (ESM)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET'
};

export default async (req) => {
  try {
    // 1) CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // 2) Simple debug for GET
    if (req.method === 'GET') {
      return new Response(
        JSON.stringify({ ok: false, hint: 'Use POST with JSON body.' }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    // 3) Only POST for real work
    if (req.method !== 'POST') {
      return new Response(
        JSON.stringify({ ok: false, error: 'Method not allowed' }),
        { status: 405, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    // Accept image_url too (optional)
    const { user_identity, title, body, open_link_url, image_url } = await req.json();
    if (!user_identity || !title || !body) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Missing fields' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    // Keys
    const APP_KEY = process.env.APPILIX_APP_KEY;
    const API_KEY = process.env.APPILIX_API_KEY;           // legacy
    const ACCOUNT_KEY = process.env.APPILIX_ACCOUNT_KEY;   // optional/newer on some accounts

    if (!APP_KEY || (!API_KEY && !ACCOUNT_KEY)) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Server not configured' }),
        { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    // Default deep link -> /chat-list.html (use PUBLIC_BASE_URL if set; else infer from req.url)
    const base =
      process.env.PUBLIC_BASE_URL ||
      (req?.url ? new URL(req.url).origin : '');
    const finalOpen = open_link_url || (base ? `${base}/chat-list.html` : '/chat-list.html');

    // Compose form
    const form = new URLSearchParams();
    form.set('app_key', APP_KEY);
    if (API_KEY)     form.set('api_key', API_KEY);
    if (ACCOUNT_KEY) form.set('account_key', ACCOUNT_KEY);

    form.set('notification_title', title);
    form.set('notification_body', body);
    form.set('user_identity', user_identity);
    if (finalOpen) form.set('open_link_url', finalOpen);

    // Try common parameter names for image (harmless if API ignores one)
    if (image_url) {
      form.set('image_url', image_url);
      form.set('notification_image', image_url);
    }

    // Call Appilix
    const r = await fetch('https://appilix.com/api/push-notification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });

    const text = await r.text();
    if (!r.ok) {
      return new Response(
        JSON.stringify({ ok: false, status: r.status, body: text }),
        { status: 502, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    // Try to parse response body; fall back to raw text
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }

    return new Response(
      JSON.stringify({ ok: true, response: parsed }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
};
