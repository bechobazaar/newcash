// netlify/functions/send-push.js
const { google } = require('googleapis');

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
    const { tokens = [], projectId, title, body, url, icon, badge, tag } = JSON.parse(event.body || '{}');
    if (!projectId || !tokens.length) {
      return { statusCode: 400, body: 'projectId & tokens required' };
    }

    const accessToken = await getAccessToken();
    const endpoint = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

    const results = [];
    for (const token of tokens) {
      const message = {
        message: {
          token,
          data: { title, body, url, icon, badge, tag }
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

      const text = await r.text();
      results.push({ token, status: r.status, text });
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, results }) };
  } catch (e) {
    return { statusCode: 500, body: e.message || 'error' };
  }
};
