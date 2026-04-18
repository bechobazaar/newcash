// netlify/functions/replicate-proxy.js

exports.handler = async function(event, context) {
    // 1. CORS Headers - Allow browser to access this function
    const headers = {
        'Access-Control-Allow-Origin': '*', // Aap isko 'https://watchnearn.in' bhi kar sakte hain security ke liye
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
    };

    // 2. Preflight request (Browser CORS check)
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: 'Method Not Allowed' };
    }

    try {
        const body = JSON.parse(event.body);
        
        // 🔒 Aapki API Key Netlify Environment Variables se aayegi
        const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY;

        if (!REPLICATE_API_KEY) {
            return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing Replicate API Key in Netlify" }) };
        }

        // ACTION 1: Start the separation process
        if (body.action === 'start') {
            const response = await fetch("https://api.replicate.com/v1/predictions", {
                method: "POST",
                headers: {
                    "Authorization": `Token ${REPLICATE_API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    version: "1931e5f8cebb87265eb4515152a420b926dd1cd3732d8ae62e3d36cfaeac16ec",
                    input: { audio: body.audioBase64, stems: "2stems" }
                })
            });
            const data = await response.json();
            return { statusCode: response.status, headers, body: JSON.stringify(data) };
        }

        // ACTION 2: Check the status (Polling)
        if (body.action === 'check') {
            const response = await fetch(body.url, {
                method: "GET",
                headers: {
                    "Authorization": `Token ${REPLICATE_API_KEY}`
                }
            });
            const data = await response.json();
            return { statusCode: response.status, headers, body: JSON.stringify(data) };
        }

        return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid Action" }) };

    } catch (error) {
        console.error("Backend Error:", error);
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }
};
