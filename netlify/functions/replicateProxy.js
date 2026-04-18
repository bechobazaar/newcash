// File: netlify/functions/replicateProxy.js

exports.handler = async function(event, context) {
    // Netlify Dashboard se API key uthayega (Secure tareeqa)
    const API_KEY = process.env.REPLICATE_API_KEY;

    // 1. CORS Preflight (OPTIONS) ko handle karna
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            },
            body: 'OK'
        };
    }

    try {
        // 2. POLLING REQUEST (GET) - Jab frontend status check karega
        if (event.httpMethod === 'GET' && event.queryStringParameters.url) {
            const predictionUrl = event.queryStringParameters.url;
            
            const response = await fetch(predictionUrl, {
                headers: { 'Authorization': `Token ${API_KEY}` }
            });
            
            const data = await response.json();
            return {
                statusCode: 200,
                headers: { 'Access-Control-Allow-Origin': '*' },
                body: JSON.stringify(data)
            };
        }

        // 3. START PREDICTION REQUEST (POST) - Jab frontend naya audio bhejega
        if (event.httpMethod === 'POST') {
            const body = JSON.parse(event.body);
            
            const response = await fetch("https://api.replicate.com/v1/predictions", {
                method: 'POST',
                headers: {
                    'Authorization': `Token ${API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    version: "25a173108cff36ef9f80f854c162d01df9e6528be175794b81158fa03836d953", // Demucs v4
                    input: { audio: body.audio } // Yahan Base64 audio aayega
                })
            });
            
            const data = await response.json();
            return {
                statusCode: 200,
                headers: { 'Access-Control-Allow-Origin': '*' },
                body: JSON.stringify(data)
            };
        }

        return { statusCode: 400, body: 'Bad Request' };

    } catch (error) {
        return {
            statusCode: 500,
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ error: error.message })
        };
    }
};
