// netlify/functions/create-mailbox.js
// Provider: mail.tm (stable). Creates an account (address+password) and returns both to client.

const API = 'https://api.mail.tm';
const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
});

function rand(n=10){ return Math.random().toString(36).slice(2, 2+n); }
function strongPass(){
  // 12-16 chars, includes upper/lower/digit
  const base = rand(8) + Date.now().toString(36).slice(-4);
  return ('Aa1' + base).slice(0, 14);
}

async function json(method, url, body, headers){
  const r = await fetch(url, {
    method,
    headers: { "Content-Type":"application/json", ...(headers||{}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await r.text();
  let data; try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt }; }
  if(!r.ok){
    const msg = (data && (data.message || data.detail)) || `HTTP ${r.status}`;
    throw new Error(`${method} ${url} -> ${msg}`);
  }
  return data;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors(), body: "" };
  }
  try {
    // 1) pick a domain
    const doms = await json('GET', `${API}/domains`);
    if(!doms || !doms['hydra:member'] || !doms['hydra:member'].length) {
      throw new Error('No domains from mail.tm');
    }
    const domain = doms['hydra:member'][0].domain;

    // 2) create account
    const login = `bb${rand(6)}${Date.now().toString(36).slice(-3)}`;
    const address = `${login}@${domain}`;
    const password = strongPass();

    await json('POST', `${API}/accounts`, { address, password });

    // 3) return creds to client (client will send back for polling)
    return {
      statusCode: 200,
      headers: cors(),
      body: JSON.stringify({ email: address, password })
    };
  } catch (e) {
    return { statusCode: 500, headers: cors(), body: JSON.stringify({ error: String(e.message) }) };
  }
};
