// Follow redirects (HEAD/GET, manual) and return final destination without tracking.
exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };

  try {
    const { url } = event.queryStringParameters || {};
    if (!url) throw new Error("url required");
    let current = url, hops = 0;

    while (hops < 6) {
      const r = await fetch(current, { redirect: "manual", method: "GET" });
      // 2xx -> done
      if (r.status >= 200 && r.status < 300) break;
      // 3xx -> next location
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        if (!loc) break;
        current = new URL(loc, current).href; // resolve relative
        hops++; continue;
      }
      break; // other status -> stop
    }
    return { statusCode: 200, headers: cors, body: JSON.stringify({ final: current }) };
  } catch (e) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: String(e.message) }) };
  }
};
