// Netlify serverless function
// Env: GOOGLE_APPLICATION_CREDENTIALS_JSON = <service-account json>

const { google } = require('googleapis');
const fetch = require('node-fetch');

async function getAccessToken() {
  const creds = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
  const jwtClient = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ['https://www.googleapis.com/auth/firebase.messaging']
  );
  const tokens = await jwtClient.authorize();
  return tokens.access_token;
}

exports.handler = async (event) => {
  try {
    const { tokens = [], title, body, url, icon = '/logo-192.png', badge = '/badge-72.png', tag = 'bb-msg', projectId } = JSON.parse(event.body || '{}');
    if (!projectId || !tokens.length) {
      return { statusCode: 400, body: 'projectId & tokens required' };
    }
    const accessToken = await getAccessToken();
    const endpoint = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

    // multiple tokens -> loop send (or use legacy batch endpoint if needed)
    const results = [];
    for (const token of tokens) {
      const message = {
        message: {
          token,
          data: { title, body, url, icon, badge, tag },
        }
      };
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(message)
      });
      results.push({ token, status: r.status, text: await r.text() });
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, results }) };
  } catch (e) {
    return { statusCode: 500, body: e.message || 'error' };
  }
};
