// netlify/functions/appilix-push.js
// Next-gen Netlify Functions (ESM) – works on current Netlify
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

    // 2) Simple debug for GET (so browser me open karoge to yeh milega)
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

    const { user_identity, title, body, open_link_url } = await req.json();
    if (!user_identity || !title || !body) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Missing fields' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    const APP_KEY = process.env.APPILIX_APP_KEY;
    const API_KEY = process.env.APPILIX_API_KEY;
    if (!APP_KEY || !API_KEY) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Server not configured' }),
        { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    const form = new URLSearchParams();
    form.set('app_key', APP_KEY);
    form.set('api_key', API_KEY);
    form.set('notification_title', title);
    form.set('notification_body', body);
    form.set('user_identity', user_identity);
    if (open_link_url) form.set('open_link_url', open_link_url);

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

    return new Response(
      JSON.stringify({ ok: true, body: text }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
};
