/**
 * HTTP 客户端
 *
 * 基于 Node 18+ 内置 fetch，封装统一 headers、签名注入、错误处理。
 *
 * 抖音 API 关键 header（待抓包确认实际字段）：
 * - Cookie：登录态
 * - User-Agent：模拟浏览器
 * - Referer：通常为 https://www.douyin.com/
 * - X-Bogus / a_bogus / _signature：请求签名（待逆向）
 *
 * 状态：骨架，待抓包后填充实际字段。
 */
import { createLogger } from '../utils/logger.js';
const log = createLogger('http');
/**
 * 构造完整 URL（带 query 参数）
 */
function buildUrl(base, params) {
    if (!params)
        return base;
    const url = new URL(base);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) {
            url.searchParams.set(k, String(v));
        }
    }
    return url.toString();
}
/**
 * 发送 HTTP 请求
 *
 * 当前仅是骨架实现，未注入签名。
 * 抓包确认签名机制后，在 sendWithSign 中实现签名注入。
 */
export async function sendRequest(url, options = {}) {
    const { method = 'GET', params, body, headers = {}, timeoutMs = 15_000, } = options;
    const fullUrl = buildUrl(url, params);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const finalHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        Referer: 'https://www.douyin.com/',
        ...headers,
    };
    let reqBody;
    if (body !== undefined) {
        finalHeaders['Content-Type'] = 'application/json';
        reqBody = JSON.stringify(body);
    }
    log.debug(`${method} ${fullUrl}`);
    try {
        const res = await fetch(fullUrl, {
            method,
            headers: finalHeaders,
            body: reqBody,
            signal: controller.signal,
        });
        const data = (await res.json().catch(() => null));
        return {
            status: res.status,
            ok: res.ok,
            headers: res.headers,
            data,
        };
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * 带签名的请求（待实现）
 *
 * 抓包确认签名算法后实现：
 * 1. 解析 URL/params/body
 * 2. 调用 sign() 计算签名
 * 3. 将签名追加到 params 或 headers
 * 4. 发送请求
 */
export async function sendWithSign(_url, _options = {}) {
    throw new Error('NOT_IMPLEMENTED: sendWithSign 等待签名算法逆向完成后实现');
}
