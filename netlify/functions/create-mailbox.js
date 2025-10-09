const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
});

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors(), body: "" };
  }
  try {
    const url = "https://www.1secmail.com/api/v1/?action=genRandomMailbox&count=1";
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("genRandomMailbox " + resp.status);
    const data = await resp.json();
    const email = Array.isArray(data) ? data[0] : null;
    if (!email) throw new Error("No email received from provider");
    return { statusCode: 200, headers: cors(), body: JSON.stringify({ email }) };
  } catch (e) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: e.message }) };
  }
};
