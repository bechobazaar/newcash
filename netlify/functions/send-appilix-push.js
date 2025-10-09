// netlify/functions/send-appilix-push.js

const ALLOWED_ORIGINS = new Set([
  'https://bechobazaar.com',
  'https://www.bechobazaar.com',
  'http://localhost:3000',
  'http://localhost:5173',
]);

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://bechobazaar.com';
  return {
    'Access-Control-Allow-Origin': allow,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || '';
  const headers = corsHeaders(origin);

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: 'OK' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method Not Allowed' };
  }

  try {
    const { user_identity, title, message, open_link_url } = JSON.parse(event.body || '{}');

    // TODO: yahan aap Appilix API ko call karte ho
    // const resp = await fetch(APPILIX_URL, { ... });

    // For now just echo (aapka actual logic yahan rahe)
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, result: { status: 200, text: '{"status":"false","msg":"User identity is not found."}' } })
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ ok:false, error:String(e?.message||e) }) };
  }
};
