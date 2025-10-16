// Next-gen Netlify Functions (ESM)
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET'
};

function parseAppilix(text) {
  // Try JSON first
  try {
    const obj = JSON.parse(text);
    // Heuristics: mark success only if an explicit success-ish flag/text exists
    const s = String(obj.status || obj.success || obj.ok || '').toLowerCase();
    const msg = (obj.message || obj.msg || '').toLowerCase();
    const looksGood = ['ok','success','true','200'].some(t => s.includes(t)) ||
                      msg.includes('success');
    return { parsed: obj, success: looksGood };
  } catch {
    // Fallback: plain text heuristics
    const low = (text || '').toLowerCase();
    const looksGood = low.includes('success') || low.includes('"ok":true');
    return { parsed: { raw: text }, success: looksGood };
  }
}

export default async (req) => {
  try {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (req.method === 'GET') {
      return new Response(
        JSON.stringify({ ok: false, hint: 'Use POST with JSON body.' }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }
    if (req.method !== 'POST') {
      return new Response(
        JSON.stringify({ ok: false, error: 'Method not allowed' }),
        { status: 405, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    const { user_identity, title, body, open_link_url, image_url } = await req.json();
    if (!user_identity || !title || !body) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Missing fields' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    const APP_KEY = process.env.APPILIX_APP_KEY;
    const API_KEY = process.env.APPILIX_API_KEY;
    const ACCOUNT_KEY = process.env.APPILIX_ACCOUNT_KEY; // optional newer key

    if (!APP_KEY || (!API_KEY && !ACCOUNT_KEY)) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Server not configured' }),
        { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    const base = process.env.PUBLIC_BASE_URL || (req?.url ? new URL(req.url).origin : '');
    const finalOpen = open_link_url || (base ? `${base}/chat-list.html` : '/chat-list.html');

    const form = new URLSearchParams();
    form.set('app_key', APP_KEY);
    if (API_KEY)     form.set('api_key', API_KEY);
    if (ACCOUNT_KEY) form.set('account_key', ACCOUNT_KEY);
    form.set('notification_title', title);
    form.set('notification_body', body);
    form.set('user_identity', user_identity);
    form.set('open_link_url', finalOpen);
    if (image_url) {
      form.set('image_url', image_url);
      form.set('notification_image', image_url);
    }

    const r = await fetch('https://appilix.com/api/push-notification', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });

    const text = await r.text();
    // Appilix sometimes returns 200 even when not accepted; check body content
    const { parsed, success } = parseAppilix(text);

    if (!r.ok || !success) {
      return new Response(
        JSON.stringify({ ok: false, status: r.status, body: parsed }),
        { status: r.ok ? 502 : r.status, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ ok: true, body: parsed }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  }
};
