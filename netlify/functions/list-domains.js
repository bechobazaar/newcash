// netlify/functions/list-domains.js
const API = 'https://api.mail.tm';

const cors = () => ({
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
});

/** Parse hydra paginated response safely */
function parseDomains(res) {
  const items = res && res['hydra:member'] ? res['hydra:member'] : [];
  return items
    .map(d => (typeof d === 'string' ? d : d.domain || d.name || '').trim())
    .filter(Boolean);
}

async function getJson(url) {
  const r = await fetch(url, { headers: { "Accept": "application/json" }});
  const txt = await r.text();
  let data; try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt }; }
  if (!r.ok) throw new Error(`GET ${url} -> HTTP ${r.status}`);
  return data;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors(), body: "" };
  }
  try {
    // कुछ accounts में domains 1–2 pages पर होते हैं; हम 3 pages तक ट्राय करेंगे
    const pages = [1, 2, 3];
    const perPage = 100;
    const all = new Set();
    for (const p of pages) {
      try {
        const res = await getJson(`${API}/domains?page=${p}&itemsPerPage=${perPage}`);
        const got = parseDomains(res);
        got.forEach(d => all.add(d));
        // अगर अगले page का link नहीं मिला / items कम हैं तो break कर दें
        if (!res['hydra:view'] || got.length < perPage) break;
      } catch (e) {
        // अगले pages try करते रहें; कम से कम जो मिला वो दे देंगे
        break;
      }
    }

    // graceful: 200 + [] ताकि UI खुद decide कर सके
    return { statusCode: 200, headers: cors(), body: JSON.stringify([...all]) };
  } catch (e) {
    // यहाँ भी 200 + [] भेज रहे हैं, ताकि dropdown बस hide हो जाए और Auto मोड चले
    return { statusCode: 200, headers: cors(), body: JSON.stringify([]) };
  }
};
