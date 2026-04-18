export async function handler(event) {
    try {
        // ✅ CORS (har response me lagega)
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization"
        };

        // ✅ Preflight request handle
        if (event.httpMethod === "OPTIONS") {
            return {
                statusCode: 200,
                headers: corsHeaders
            };
        }

        // ❌ Only POST allowed
        if (event.httpMethod !== "POST") {
            return {
                statusCode: 405,
                headers: corsHeaders,
                body: JSON.stringify({ error: "Method Not Allowed" })
            };
        }

        // 🔐 API KEY from Netlify ENV
        const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY;
        if (!REPLICATE_API_KEY) {
            return {
                statusCode: 500,
                headers: corsHeaders,
                body: JSON.stringify({ error: "Missing API Key" })
            };
        }

        // 📦 Parse body
        const body = JSON.parse(event.body || "{}");
        const base64Audio = body.audio;

        if (!base64Audio) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ error: "No audio provided" })
            };
        }

        // 🚀 STEP 1: Create prediction
        const createRes = await fetch("https://api.replicate.com/v1/predictions", {
            method: "POST",
            headers: {
                "Authorization": `Token ${REPLICATE_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                version: "25a173108cff36ef9f80f854c162d01df9e6528be175794b81158fa03836d953",
                input: {
                    audio: base64Audio
                }
            })
        });

        const createData = await createRes.json();

        if (!createRes.ok) {
            return {
                statusCode: 500,
                headers: corsHeaders,
                body: JSON.stringify({ error: createData.detail || "Replicate error" })
            };
        }

        const pollUrl = createData.urls.get;

        // 🔄 STEP 2: Polling loop (server side)
        let result = null;
        let attempts = 0;

        while (attempts < 60) {
            attempts++;

            const statusRes = await fetch(pollUrl, {
                headers: {
                    "Authorization": `Token ${REPLICATE_API_KEY}`
                }
            });

            const pollData = await statusRes.json();

            if (pollData.status === "succeeded") {
                result = pollData.output;
                break;
            }

            if (pollData.status === "failed") {
                return {
                    statusCode: 500,
                    headers: corsHeaders,
                    body: JSON.stringify({ error: "AI processing failed" })
                };
            }

            // ⏳ wait 2 sec
            await new Promise(r => setTimeout(r, 2000));
        }

        if (!result) {
            return {
                statusCode: 500,
                headers: corsHeaders,
                body: JSON.stringify({ error: "Timeout processing audio" })
            };
        }

        // ✅ SUCCESS RESPONSE
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
                vocals: result.vocals,
                music: result.other
            })
        };

    } catch (err) {
        return {
            statusCode: 500,
            headers: {
                "Access-Control-Allow-Origin": "*"
            },
            body: JSON.stringify({
                error: err.message || "Server error"
            })
        };
    }
}
