const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
});
const parseEmail = (e) => {
  if (!e || !e.includes("@")) throw new Error("Invalid email");
  const [login, domain] = e.split("@");
  return { login, domain };
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors(), body: "" };
  }
  try {
    const email = (event.queryStringParameters && event.queryStringParameters.email) || "";
    const { login, domain } = parseEmail(email);

    const listUrl = `https://www.1secmail.com/api/v1/?action=getMessages&login=${encodeURIComponent(login)}&domain=${encodeURIComponent(domain)}`;
    const listResp = await fetch(listUrl);
    if (!listResp.ok) throw new Error("getMessages " + listResp.status);
    const list = await listResp.json();

    const full = await Promise.all((list || []).map(async (msg) => {
      try {
        const readUrl = `https://www.1secmail.com/api/v1/?action=readMessage&login=${encodeURIComponent(login)}&domain=${encodeURIComponent(domain)}&id=${encodeURIComponent(msg.id)}`;
        const readResp = await fetch(readUrl);
        if (!readResp.ok) throw new Error("readMessage " + readResp.status);
        const m = await readResp.json();
        return { id:m.id, from:m.from, subject:m.subject, date:m.date, textBody:m.textBody || m.body || "" };
      } catch {
        return { id:msg.id, from:msg.from, subject:msg.subject, date:msg.date, textBody:"" };
      }
    }));
    full.sort((a,b)=> new Date(b.date) - new Date(a.date));

    return { statusCode: 200, headers: cors(), body: JSON.stringify(full) };
  } catch (e) {
    return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: e.message }) };
  }
};
