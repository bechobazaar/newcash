// netlify/functions/create-mailbox.js
const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
});

const genUrl = "https://www.1secmail.com/api/v1/?action=genRandomMailbox&count=1";

// 1secmail supports creating a mailbox with your own login as fallback:
function makeCreateUrl(login, domain = "1secmail.com") {
  return `https://www.1secmail.com/api/v1/?action=genRandomMailbox&count=1&login=${encodeURIComponent(
    login
  )}&domain=${encodeURIComponent(domain)}`;
}

function randomLogin() {
  return (
    "bb" +
    Math.random().toString(36).slice(2, 8) +
    Date.now().toString(36).slice(-4)
  );
}

async function tryFetchJSON(url) {
  const r = await fetch(url, {
    method: "GET",
    // some providers behave nicer with a UA
    headers: { "User-Agent": "Mozilla/5.0 (Netlify Function)" },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors(), body: "" };
  }

  try {
    // --- attempt 1: normal random generator
    try {
      const data = await tryFetchJSON(genUrl);
      const email = Array.isArray(data) ? data[0] : null;
      if (email) {
        return { statusCode: 200, headers: cors(), body: JSON.stringify({ email }) };
      }
      throw new Error("Empty email from generator");
    } catch (e1) {
      // --- attempt 2: fallback to create with our own random login
      const login = randomLogin();
      const url2 = makeCreateUrl(login);
      try {
        const data2 = await tryFetchJSON(url2);
        const email2 = Array.isArray(data2) ? data2[0] : null;
        if (email2) {
          return { statusCode: 200, headers: cors(), body: JSON.stringify({ email: email2 }) };
        }
        throw new Error("Empty email from fallback");
      } catch (e2) {
        // --- give a clean error to the client
        return {
          statusCode: 502,
          headers: cors(),
          body: JSON.stringify({
            error: "Mailbox provider failed",
            details: [String(e1.message), String(e2.message)],
          }),
        };
      }
    }
  } catch (e) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: String(e.message) }) };
  }
};
