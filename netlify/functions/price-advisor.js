// netlify/functions/price-advisor.js

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro-latest:generateContent";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { item, comps, wantWeb = true } = JSON.parse(event.body || "{}");

    // ---- (Optional) Google Custom Search snippets
    let webSnippets = [];
    const CSE_KEY = process.env.CSE_KEY;
    const CSE_CX  = process.env.CSE_CX;
    if (wantWeb && CSE_KEY && CSE_CX) {
      const qBase = [item?.brand, item?.model, item?.variant, "India price"]
        .filter(Boolean).join(" ");
      const queries = [
        qBase,
        `${item?.brand || ""} ${item?.model || ""} launch price India`,
        `${item?.brand || ""} ${item?.model || ""} used price India`,
      ];
      for (const q of queries) {
        try{
          const r = await fetch(
            `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(CSE_KEY)}&cx=${encodeURIComponent(CSE_CX)}&num=3&q=${encodeURIComponent(q)}`
          );
          if (r.ok) {
            const data = await r.json();
            webSnippets.push({
              query: q,
              items: (data.items || []).map(it => ({
                title: it.title, link: it.link, snippet: it.snippet
              }))
            });
          }
        }catch{}
      }
    }

    // ---- Gemini
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return { statusCode: 500, body: "Missing GEMINI_API_KEY" };
    }

    const schema = {
      type: "object",
      properties: {
        summary: { type: "string" },
        priceBands: {
          type: "object",
          properties: {
            quick: { type: "number" },
            suggested: { type: "number" },
            patient: { type: "number" },
            median: { type: "number" },
            p25: { type: "number" },
            p75: { type: "number" }
          },
          required: ["suggested"]
        },
        reasoningPoints: { type: "array", items: { type: "string" } },
        compsUsed: { type: "array", items: { type: "object" } },
        caveats: { type: "array", items: { type: "string" } },
        sources: { type: "array", items: { type: "object" } }
      },
      required: ["priceBands","summary"]
    };

    const prompt =
`You are a pricing analyst for an Indian classifieds marketplace.
Use comps first; public snippets only as context. Trim outliers.
Return INR whole numbers and three bands: quick/suggested/patient. JSON only.`;

    const body = {
      contents: [{
        role: "user",
        parts: [
          { text: prompt },
          { text: "ITEM:" },               { text: JSON.stringify(item || {}) },
          { text: "COMPARABLE_LISTINGS:" },{ text: JSON.stringify(comps || []) },
          { text: "PUBLIC_SNIPPETS:" },    { text: JSON.stringify(webSnippets) }
        ]
      }],
      generationConfig: {
        temperature: 0.2, topP: 0.9, maxOutputTokens: 1024,
        responseMimeType: "application/json", responseSchema: schema
      }
    };

    const resp = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const t = await resp.text();
      return { statusCode: 502, body: `Gemini error: ${t}` };
    }

    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    return { statusCode: 200, headers: { "content-type": "application/json" }, body: text };
  } catch (e) {
    return { statusCode: 500, body: String(e?.message || e) };
  }
};
