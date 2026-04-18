const fetch = require('node-fetch'); // Netlify defaults to providing fetch, but this ensures it

exports.handler = async function(event, context) {
    // 1. Unified CORS Headers
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type': 'application/json'
    };

    // 2. Preflight Response
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    try {
        const REPLICATE_API_KEY = process.env.REPLICATE_API_KEY;
        if (!REPLICATE_API_KEY) throw new Error("REPLICATE_API_KEY is not set in Netlify Environment Variables.");

        const body = JSON.parse(event.body);

        // 🚀 ACTION: START SEPARATION
        if (body.action === 'start') {
            const payloadSize = Buffer.byteLength(event.body);
            console.log(`[START] Payload size: ${(payloadSize / 1024 / 1024).toFixed(2)} MB`);

            // Netlify limit guard
            if (payloadSize > 6000000) { 
                return { statusCode: 413, headers, body: JSON.stringify({ error: "Audio data too heavy (Netlify 6MB Limit). Try a shorter clip." }) };
            }

            const response = await fetch("https://api.replicate.com/v1/predictions", {
                method: "POST",
                headers: {
                    "Authorization": `Token ${REPLICATE_API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    // Model: Spleeter (cjwbw/spleeter)
                    version: "1931e5f8cebb87265eb4515152a420b926dd1cd3732d8ae62e3d36cfaeac16ec",
                    input: { audio: body.audioBase64, stems: "2stems" }
                })
            });

            const data = await response.json();
            return { statusCode: response.status, headers, body: JSON.stringify(data) };
        }

        // 🚀 ACTION: CHECK STATUS
        if (body.action === 'check') {
            if (!body.url) throw new Error("Polling URL is missing.");

            const response = await fetch(body.url, {
                method: "GET",
                headers: { "Authorization": `Token ${REPLICATE_API_KEY}` }
            });

            const data = await response.json();
            return { statusCode: response.status, headers, body: JSON.stringify(data) };
        }

        return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid action request." }) };

    } catch (error) {
        console.error("Netlify Function Error:", error.message);
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }
};
