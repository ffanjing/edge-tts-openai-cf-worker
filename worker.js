const encoder = new TextEncoder();
let expiredAt = null;
let endpoint = null;
let clientId = "76a75279-2ffa-4c3d-8db8-7b47252aa41c";

// 缓存和预刷新机制
const TOKEN_REFRESH_BEFORE_EXPIRY = 5 * 60; // 提前5分钟刷新token
let tokenInfo = {
    endpoint: null,
    token: null,
    expiredAt: null
};

// 语音名称映射表
const VOICE_MAPPING = {
    'alloy': 'zh-CN-XiaoxiaoNeural',
    'echo': 'zh-CN-YunxiNeural', 
    'fable': 'zh-CN-XiaoyiNeural',
    'onyx': 'zh-CN-YunyangNeural',
    'nova': 'zh-CN-XiaohanNeural',
    'shimmer': 'zh-CN-XiaomengNeural'
};

export default {
    async fetch(request, env, ctx) {
        return handleRequest(request, env);
    }
};

async function handleRequest(request, env) {
    if (request.method === "OPTIONS") {
        return handleOptions(request);
    }
    
    // 从 env 读取 API_KEY
    const API_KEY = env.API_KEY;
    const requestUrl = new URL(request.url);
    const path = requestUrl.pathname;
    
    // 只在设置了 API_KEY 的情况下才验证
    if (API_KEY) {
        const authHeader = request.headers.get("authorization");
        // 兼容 GET 请求：优先从 Headers 读，读不到再从 URL 参数的 ?key= 读
        let apiKey = authHeader?.startsWith("Bearer ") 
            ? authHeader.slice(7) 
            : null;
            
        if (!apiKey) {
            apiKey = requestUrl.searchParams.get("key"); // 支持 URL 传参校验
        }
                      
        if (apiKey !== API_KEY) {
            return new Response(JSON.stringify({
                error: {
                    message: "Invalid API key. Use header 'Authorization: Bearer your-key' or URL param '&key=your-key'",
                    type: "invalid_request_error",
                    param: null,
                    code: "invalid_api_key"
                }
            }), {
                status: 401,
                headers: {
                    "Content-Type": "application/json",
                    ...makeCORSHeaders()
                }
            });
        }
    }

    // 同时兼容旧的 OpenAI 路径和更语义化的 /tts 路径
    if (path === "/v1/audio/speech" || path === "/tts") {
        try {
            let input, voice, speed, pitch, style;

            // 【核心修改】如果是 GET 请求，从 URL 参数解析
            if (request.method === "GET") {
                input = requestUrl.searchParams.get("input") || "";
                voice = requestUrl.searchParams.get("voice") || "zh-CN-XiaoxiaoNeural";
                speed = parseFloat(requestUrl.searchParams.get("speed") || "1.0");
                pitch = parseFloat(requestUrl.searchParams.get("pitch") || "1.0");
                style = requestUrl.searchParams.get("style") || "general";
            } 
            // 如果还想保留原本的 POST 兼容（比如某些第三方客户端调用）
            else if (request.method === "POST") {
                const requestBody = await request.json();
                input = requestBody.input || "";
                voice = requestBody.voice || "zh-CN-XiaoxiaoNeural";
                speed = requestBody.speed || 1.0;
                pitch = requestBody.pitch || 1.0;
                style = requestBody.style || "general";
            }

            if (!input) {
                return new Response(JSON.stringify({ error: "Missing 'input' parameter" }), {
                    status: 400,
                    headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
                });
            }

            // 语音名称映射
            voice = VOICE_MAPPING[voice] || voice; 

            const rate = ((speed - 1) * 100).toFixed(0);
            const numPitch = ((pitch - 1) * 100).toFixed(0); 
            
            const response = await getVoice(
                input, 
                voice, 
                rate,
                numPitch,
                style,
                "audio-24khz-48kbitrate-mono-mp3",
                false
            );

            return response;

        } catch (error) {
            console.error("Error:", error);
            return new Response(JSON.stringify({
                error: {
                    message: error.message,
                    type: "api_error",
                    param: null,
                    code: "edge_tts_error"
                }
            }), {
                status: 500,
                headers: {
                    "Content-Type": "application/json",
                    ...makeCORSHeaders()
                }
            });
        }
    }

    return new Response("Not Found", { status: 404 });
}

async function handleOptions(request) {
    return new Response(null, {
        status: 204,
        headers: {
            ...makeCORSHeaders(),
            "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
            "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") || "Authorization"
        }
    });
}

async function getVoice(text, voiceName = "zh-CN-XiaoxiaoNeural", rate = 0, pitch = 0, style = "general", outputFormat = "audio-24khz-48kbitrate-mono-mp3", download = false) {
    try {
        const maxChunkSize = 2000; 
        const chunks = [];

        for (let i = 0; i < text.length; i += maxChunkSize) {
            const chunk = text.slice(i, i + maxChunkSize);
            chunks.push(chunk);
        }

        const audioChunks = await Promise.all(chunks.map(chunk => getAudioChunk(chunk, voiceName, rate, pitch, style, outputFormat)));
        const concatenatedAudio = new Blob(audioChunks, { type: 'audio/mpeg' });
        
        const response = new Response(concatenatedAudio, {
            headers: {
                "Content-Type": "audio/mpeg",
                ...makeCORSHeaders()
            }
        });

        if (download) {
            response.headers.set("Content-Disposition", `attachment; filename="${uuid()}.mp3"`);
        }

        return response;

    } catch (error) {
        console.error("语音合成失败:", error);
        return new Response(JSON.stringify({
            error: { message: error.message, type: "api_error", param: null, code: "edge_tts_error" }
        }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
        });
    }
}

async function getAudioChunk(text, voiceName, rate, pitch, style, outputFormat) {
    const endpoint = await getEndpoint();
    const url = `https://${endpoint.r}.tts.speech.microsoft.com/cognitiveservices/v1`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": endpoint.t,
            "Content-Type": "application/ssml+xml",
            "User-Agent": "okhttp/4.5.0",
            "X-Microsoft-OutputFormat": outputFormat
        },
        body: getSsml(text, voiceName, rate, pitch, style)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Edge TTS API error: ${response.status} ${errorText}`);
    }

    return response.blob();
}

function getSsml(text, voiceName, rate, pitch, style) {
    return `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="zh-CN"> 
                <voice name="${voiceName}"> 
                    <mstts:express-as style="${style}"  styledegree="1.0" role="default" > 
                        <prosody rate="${rate}%" pitch="${pitch}%" volume="50">${text}</prosody> 
                    </mstts:express-as> 
                </voice> 
            </speak>`;
}

async function getEndpoint() {
    const now = Date.now() / 1000;
    if (tokenInfo.token && tokenInfo.expiredAt && now < tokenInfo.expiredAt - TOKEN_REFRESH_BEFORE_EXPIRY) {
        return tokenInfo.endpoint;
    }

    const endpointUrl = "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0";
    const clientId = crypto.randomUUID().replace(/-/g, "");
    
    try {
        const response = await fetch(endpointUrl, {
            method: "POST",
            headers: {
                "Accept-Language": "zh-Hans",
                "X-ClientVersion": "4.0.530a 5fe1dc6c",
                "X-UserId": "0f04d16a175c411e",
                "X-HomeGeographicRegion": "zh-Hans-CN",
                "X-ClientTraceId": clientId,
                "X-MT-Signature": await sign(endpointUrl),
                "User-Agent": "okhttp/4.5.0",
                "Content-Type": "application/json; charset=utf-8",
                "Content-Length": "0",
                "Accept-Encoding": "gzip"
            }
        });

        if (!response.ok) {
            throw new Error(`获取endpoint失败: ${response.status}`);
        }

        const data = await response.json();
        const jwt = data.t.split(".")[1];
        const decodedJwt = JSON.parse(atob(jwt));
        
        tokenInfo = {
            endpoint: data,
            token: data.t,
            expiredAt: decodedJwt.exp
        };

        return data;
    } catch (error) {
        console.error("获取endpoint失败:", error);
        if (tokenInfo.token) return tokenInfo.endpoint;
        throw error;
    }
}

function makeCORSHeaders() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, x-api-key",
        "Access-Control-Max-Age": "86400"
    };
}

async function hmacSha256(key, data) {
    const cryptoKey = await crypto.subtle.importKey(
        "raw", key, { name: "HMAC", hash: { name: "SHA-256" } }, false, ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
    return new Uint8Array(signature);
}

async function base64ToBytes(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

async function bytesToBase64(bytes) {
    return btoa(String.fromCharCode.apply(null, bytes));
}

function uuid() {
    return crypto.randomUUID().replace(/-/g, "");
}

async function sign(urlStr) {
    const url = urlStr.split("://")[1];
    const encodedUrl = encodeURIComponent(url);
    const uuidStr = uuid();
    const formattedDate = dateFormat();
    const bytesToSign = `MSTranslatorAndroidApp${encodedUrl}${formattedDate}${uuidStr}`.toLowerCase();
    const decode = await base64ToBytes("oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==");
    const signData = await hmacSha256(decode, bytesToSign);
    const signBase64 = await bytesToBase64(signData);
    return `MSTranslatorAndroidApp::${signBase64}::${formattedDate}::${uuidStr}`;
}

function dateFormat() {
    return ((new Date()).toUTCString().replace(/GMT/, "").trim() + " GMT").toLowerCase();
}
