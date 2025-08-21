// netlify/functions/send-push.js
// Sends FCM HTTP v1 push notifications to a list of device tokens.
// Requires env var: GOOGLE_APPLICATION_CREDENTIALS_JSON (Service Account JSON content)

const { JWT } = require('google-auth-library');

// --- util: CORS headers (honor ALLOWED_ORIGINS if provided) ---
function buildCorsHeaders(event) {
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const origin = event.headers?.origin || '';
  const allowOrigin = allowed.length ? (allowed.includes(origin) ? origin : allowed[0]) : (origin || '*');
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function jsonResponse(statusCode, body, event) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...buildCorsHeaders(event),
    },
    body: JSON.stringify(body),
  };
}

// --- auth: get OAuth2 access token for FCM scope ---
async function getAccessToken() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    throw new Error('Missing GOOGLE_APPLICATION_CREDENTIALS_JSON env var');
  }
  let creds;
  try {
    creds = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  } catch {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON');
  }
  const client = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
  });
  const { token } = await client.authorize();
  if (!token) throw new Error('Failed to obtain Google OAuth access token');
  return token;
}

exports.handler = async (event) => {
  // Preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: buildCorsHeaders(event),
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method Not Allowed' }, event);
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' }, event);
  }

  const {
    projectId,          // e.g. "olxhub-12479"
    tokens = [],        // array of FCM device tokens
    title,              // string
    body,               // string
    url,                // deep link path e.g. /chat.html?chatId=...&u=...
    icon = '/logo-192.png',
    badge = '/badge-72.png',
    tag = 'bb-msg',
    data = {},          // optional extra data fields
  } = payload;

  if (!projectId || !Array.isArray(tokens) || tokens.length === 0) {
    return jsonResponse(400, { error: 'projectId and tokens[] are required' }, event);
  }

  // build once
  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch (e) {
    return jsonResponse(500, { error: e.message || 'Auth error' }, event);
  }

  const endpoint = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

  // Prepare common data payload (we use data-only so SW handles display)
  const baseData = {
    title: String(title || 'New message'),
    body: String(body || 'Tap to open chat'),
    url: String(url || '/chat-list.html'),
    icon: String(icon || '/logo-192.png'),
    badge: String(badge || '/badge-72.png'),
    tag: String(tag || 'bb-msg'),
    ...Object.fromEntries(
      Object.entries(data || {}).map(([k, v]) => [k, v == null ? '' : String(v)])
    ),
  };

  const results = [];
  for (const token of tokens) {
    // Skip obvious bad values
    if (!token || typeof token !== 'string') {
      results.push({ token, status: 0, error: 'invalid token value' });
      continue;
    }

    const message = {
      message: {
        token,
        // Data-only message; SW (firebase-messaging-sw.js) shows the notification
        data: baseData,
      },
    };

    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
      });

      const text = await r.text();
      // FCM returns 200 on success; body contains messageName JSON
      if (!r.ok) {
        results.push({ token, status: r.status, error: text });
      } else {
        results.push({ token, status: r.status, response: (() => {
          try { return JSON.parse(text); } catch { return text; }
        })() });
      }
    } catch (e) {
      results.push({ token, status: 0, error: e.message || 'fetch error' });
    }
  }

  // Optional: summarize invalid tokens
  const invalid = results.filter(r =>
    typeof r.error === 'string' &&
    /registration-token|not-registered|invalid/i.test(r.error)
  ).map(r => r.token);

  return jsonResponse(200, { ok: true, results, invalid }, event);
};
