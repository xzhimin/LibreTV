// edge-functions/proxy/[[path]].js
// EdgeOne Pages 版本的代理函数

const MEDIA_FILE_EXTENSIONS = [
    '.mp4', '.webm', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.f4v', '.m4v', '.3gp', '.3g2', '.ts', '.mts', '.m2ts',
    '.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma', '.alac', '.aiff', '.opus',
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.svg', '.avif', '.heic'
];
const MEDIA_CONTENT_TYPES = ['video/', 'audio/', 'image/'];

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    // OPTIONS 预检请求
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
                'Access-Control-Allow-Headers': '*',
                'Access-Control-Max-Age': '86400',
            },
        });
    }

    // 鉴权
    const isValidAuth = await validateAuth(request, env);
    if (!isValidAuth) {
        return new Response(JSON.stringify({
            success: false,
            error: '代理访问未授权：请检查密码配置或鉴权参数'
        }), {
            status: 401,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            }
        });
    }

    const DEBUG_ENABLED = (env.DEBUG === 'true');
    const CACHE_TTL = parseInt(env.CACHE_TTL || '86400');
    const MAX_RECURSION = parseInt(env.MAX_RECURSION || '5');
    let USER_AGENTS = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];
    try {
        const agentsJson = env.USER_AGENTS_JSON;
        if (agentsJson) {
            const parsed = JSON.parse(agentsJson);
            if (Array.isArray(parsed) && parsed.length > 0) USER_AGENTS = parsed;
        }
    } catch (e) { /* use default */ }

    function logDebug(msg) {
        if (DEBUG_ENABLED) console.log(`[Proxy] ${msg}`);
    }

    function getTargetUrlFromPath(pathname) {
        const encodedUrl = pathname.replace(/^\/proxy\//, '');
        if (!encodedUrl) return null;
        try {
            let decoded = decodeURIComponent(encodedUrl);
            if (!decoded.match(/^https?:\/\//i)) {
                if (encodedUrl.match(/^https?:\/\//i)) {
                    decoded = encodedUrl;
                } else {
                    return null;
                }
            }
            return decoded;
        } catch (e) {
            return null;
        }
    }

    function createResponse(body, status = 200, headers = {}) {
        const h = new Headers(headers);
        h.set('Access-Control-Allow-Origin', '*');
        h.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
        h.set('Access-Control-Allow-Headers', '*');
        return new Response(body, { status, headers: h });
    }

    function createM3u8Response(content) {
        return createResponse(content, 200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': `public, max-age=${CACHE_TTL}`
        });
    }

    function getRandomUserAgent() {
        return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    }

    function getBaseUrl(urlStr) {
        try {
            const p = new URL(urlStr);
            if (!p.pathname || p.pathname === '/') return `${p.origin}/`;
            const parts = p.pathname.split('/');
            parts.pop();
            return `${p.origin}${parts.join('/')}/`;
        } catch (e) {
            const i = urlStr.lastIndexOf('/');
            return i > urlStr.indexOf('://') + 2 ? urlStr.substring(0, i + 1) : urlStr + '/';
        }
    }

    function resolveUrl(baseUrl, relativeUrl) {
        if (relativeUrl.match(/^https?:\/\//i)) return relativeUrl;
        try {
            return new URL(relativeUrl, baseUrl).toString();
        } catch (e) {
            if (relativeUrl.startsWith('/')) {
                const u = new URL(baseUrl);
                return `${u.origin}${relativeUrl}`;
            }
            return `${baseUrl.replace(/\/[^/]*$/, '/')}${relativeUrl}`;
        }
    }

    function rewriteUrlToProxy(targetUrl) {
        return `/proxy/${encodeURIComponent(targetUrl)}`;
    }

    async function fetchContentWithType(targetUrl) {
        const headers = new Headers({
            'User-Agent': getRandomUserAgent(),
            'Accept': '*/*',
            'Accept-Language': request.headers.get('Accept-Language') || 'zh-CN,zh;q=0.9,en;q=0.8',
            'Referer': request.headers.get('Referer') || new URL(targetUrl).origin
        });
        logDebug(`请求: ${targetUrl}`);
        const response = await fetch(targetUrl, { headers, redirect: 'follow' });
        if (!response.ok) {
            const body = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status}: ${response.statusText}. URL: ${targetUrl}. Body: ${body.substring(0, 150)}`);
        }
        const content = await response.text();
        const contentType = response.headers.get('Content-Type') || '';
        logDebug(`成功: ${targetUrl}, Type: ${contentType}, Len: ${content.length}`);
        return { content, contentType, responseHeaders: response.headers };
    }

    function isM3u8Content(content, contentType) {
        if (contentType && (contentType.includes('application/vnd.apple.mpegurl') || contentType.includes('application/x-mpegurl') || contentType.includes('audio/mpegurl'))) {
            return true;
        }
        return content && typeof content === 'string' && content.trim().startsWith('#EXTM3U');
    }

    function processKeyLine(line, baseUrl) {
        return line.replace(/URI="([^"]+)"/, (match, uri) => {
            const abs = resolveUrl(baseUrl, uri);
            return `URI="${rewriteUrlToProxy(abs)}"`;
        });
    }

    function processMapLine(line, baseUrl) {
        return line.replace(/URI="([^"]+)"/, (match, uri) => {
            const abs = resolveUrl(baseUrl, uri);
            return `URI="${rewriteUrlToProxy(abs)}"`;
        });
    }

    function processMediaPlaylist(url, content) {
        const baseUrl = getBaseUrl(url);
        const lines = content.split('\n');
        const output = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line && i === lines.length - 1) { output.push(line); continue; }
            if (!line) continue;
            if (line.startsWith('#EXT-X-KEY')) { output.push(processKeyLine(line, baseUrl)); continue; }
            if (line.startsWith('#EXT-X-MAP')) { output.push(processMapLine(line, baseUrl)); continue; }
            if (line.startsWith('#EXTINF')) { output.push(line); continue; }
            if (!line.startsWith('#')) {
                const abs = resolveUrl(baseUrl, line);
                output.push(rewriteUrlToProxy(abs));
                continue;
            }
            output.push(line);
        }
        return output.join('\n');
    }

    async function processM3u8Content(targetUrl, content, depth = 0) {
        if (content.includes('#EXT-X-STREAM-INF') || content.includes('#EXT-X-MEDIA:')) {
            return await processMasterPlaylist(targetUrl, content, depth);
        }
        return processMediaPlaylist(targetUrl, content);
    }

    async function processMasterPlaylist(url, content, depth) {
        if (depth > MAX_RECURSION) {
            throw new Error(`递归层数过多 (${MAX_RECURSION}): ${url}`);
        }
        const baseUrl = getBaseUrl(url);
        const lines = content.split('\n');
        let highestBw = -1;
        let bestUrl = '';

        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
                let variantUri = '';
                for (let j = i + 1; j < lines.length; j++) {
                    const l = lines[j].trim();
                    if (l && !l.startsWith('#')) { variantUri = l; i = j; break; }
                }
                if (variantUri && bw >= highestBw) {
                    highestBw = bw;
                    bestUrl = resolveUrl(baseUrl, variantUri);
                }
            }
        }

        if (!bestUrl) {
            for (let i = 0; i < lines.length; i++) {
                const l = lines[i].trim();
                if (l && !l.startsWith('#') && (l.endsWith('.m3u8') || l.includes('.m3u8?'))) {
                    bestUrl = resolveUrl(baseUrl, l);
                    break;
                }
            }
        }

        if (!bestUrl) {
            return processMediaPlaylist(url, content);
        }

        logDebug(`选择子列表 (BW: ${highestBw}): ${bestUrl}`);
        const { content: variantContent, contentType: variantCT } = await fetchContentWithType(bestUrl);

        if (!isM3u8Content(variantContent, variantCT)) {
            return processMediaPlaylist(bestUrl, variantContent);
        }

        return await processM3u8Content(bestUrl, variantContent, depth + 1);
    }

    // --- 主逻辑 ---
    try {
        const targetUrl = getTargetUrlFromPath(url.pathname);
        if (!targetUrl) {
            return createResponse('无效的代理请求路径', 400);
        }
        logDebug(`代理请求: ${targetUrl}`);

        const { content, contentType, responseHeaders } = await fetchContentWithType(targetUrl);

        if (isM3u8Content(content, contentType)) {
            logDebug(`M3U8 内容，处理中: ${targetUrl}`);
            const processed = await processM3u8Content(targetUrl, content, 0);
            return createM3u8Response(processed);
        } else {
            const finalHeaders = new Headers(responseHeaders);
            finalHeaders.set('Cache-Control', `public, max-age=${CACHE_TTL}`);
            finalHeaders.set('Access-Control-Allow-Origin', '*');
            finalHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
            finalHeaders.set('Access-Control-Allow-Headers', '*');
            return createResponse(content, 200, finalHeaders);
        }
    } catch (error) {
        logDebug(`代理错误: ${error.message}`);
        return createResponse(`代理处理错误: ${error.message}`, 500);
    }
}

async function validateAuth(request, env) {
    const url = new URL(request.url);
    const authHash = url.searchParams.get('auth');
    const timestamp = url.searchParams.get('t');

    const serverPassword = env.PASSWORD;
    if (!serverPassword) {
        console.error('未设置 PASSWORD 环境变量');
        return false;
    }

    try {
        const encoder = new TextEncoder();
        const data = encoder.encode(serverPassword);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const serverHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        if (!authHash || authHash !== serverHash) {
            return false;
        }
    } catch (error) {
        console.error('哈希计算失败:', error);
        return false;
    }

    if (timestamp) {
        const now = Date.now();
        if (now - parseInt(timestamp) > 10 * 60 * 1000) {
            return false;
        }
    }

    return true;
}
