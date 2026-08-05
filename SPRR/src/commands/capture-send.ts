/**
 * 抓包发送消息请求（开发调试用）
 *
 * 启动已登录的浏览器（复用 storageState），导航到抖音私信页，
 * 监听浏览器发出的 /v1/message/send 请求，把请求头、请求体、响应体完整保存到文件。
 *
 * 用途：
 *   - 当 sendMessage 返回空响应（cmd=0 seq=0 body=0B）时，用此命令对比浏览器真实请求
 *   - 确认抖音是否修改了发送消息的请求格式
 *   - 排查签名/Cookie/风控问题
 *
 * 使用流程：
 *   1. send --dev --out --to TwT --text "测试"
 *   2. 命令启动浏览器，导航到 https://www.douyin.com/chat
 *   3. 用户在浏览器中手动找到目标用户，发送任意一条消息
 *   4. 工具捕获到 /v1/message/send 请求后保存到 data/capture/send/ 目录
 *   5. 用户 Ctrl+C 退出
 *
 * 输出文件：
 *   data/capture/send/send-<timestamp>.json
 *   {
 *     "timestamp": "...",
 *     "request": {
 *       "url": "...",
 *       "method": "POST",
 *       "headers": {...},
 *       "bodyBase64": "...",
 *       "bodyHex": "..."
 *     },
 *     "response": {
 *       "status": 200,
 *       "headers": {...},
 *       "bodyBase64": "..."
 *     }
 *   }
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';
import { DATA_DIR } from '../config/paths.js';

const log = createLogger('capture-send');

/** 抓包文件保存目录 */
const CAPTURE_DIR = path.join(DATA_DIR, 'capture', 'send');

/** identity_security_token 抓包保存目录 */
const CAPTURE_TOKEN_DIR = path.join(DATA_DIR, 'capture', 'token');

/** 等待用户手动发送消息的超时（毫秒，5 分钟） */
const WAIT_TIMEOUT_MS = 5 * 60 * 1000;

/** 浏览器 UA */
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export interface CaptureSendOptions {
  /** storageState 文件路径（已登录账号） */
  storageStatePath: string;
  /** 是否无头模式（默认 false，用户需要看到浏览器来手动操作） */
  headless?: boolean;
  /** 超时毫秒数 */
  timeoutMs?: number;
}

/** 单次抓包结果 */
interface CapturedRequest {
  timestamp: string;
  request: {
    url: string;
    method: string;
    headers: Record<string, string>;
    bodyBase64: string;
    bodyHex: string;
    bodySize: number;
  };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    bodyBase64: string;
    bodySize: number;
  } | null;
}

/**
 * 启动浏览器，捕获 /v1/message/send 请求
 *
 * @returns 抓包结果数组（可能多次发送）
 */
export async function captureSendRequests(
  options: CaptureSendOptions,
): Promise<CapturedRequest[]> {
  const { storageStatePath, headless = false, timeoutMs = WAIT_TIMEOUT_MS } = options;
  const { chromium } = await import('playwright');

  log.info(`启动浏览器（storageState: ${storageStatePath}, headless: ${headless}）`);

  const browser = await chromium.launch({
    headless,
    args: ['--disable-blink-features=AutomationControlled', '--window-size=1400,900'],
  });

  const context = await browser.newContext({
    storageState: storageStatePath,
    userAgent: DEFAULT_UA,
    // viewport=null 让页面视口跟随窗口大小（全屏化时内容自动适应）
    viewport: null,
    screen: { width: 1920, height: 1080 },
    locale: 'zh-CN',
  });

  // 注入 webdriver 隐藏脚本（字符串形式，避免 __name 问题）
  await context.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  `);

  const page = await context.newPage();

  const captured: CapturedRequest[] = [];
  const tokenCaptured: CapturedRequest[] = [];

  /** 判断是否为 identity_security_token 请求 */
  const isTokenRequest = (url: string) =>
    url.includes('identity_security_token') || url.includes('get_identity_security');

  /** 判断是否为 message/send 请求 */
  const isSendRequest = (url: string) => url.includes('/v1/message/send');

  /** 脱敏 headers 中的 cookie */
  const sanitizeHeaders = (allHeaders: Record<string, string>): Record<string, string> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(allHeaders)) {
      if (k.toLowerCase() === 'cookie' && typeof v === 'string') {
        headers[k] = v.replace(/(sessionid=)([^;]+)/g, (_, p1, p2) => `${p1}${p2.slice(0, 8)}***`);
      } else {
        headers[k] = v;
      }
    }
    return headers;
  };

  // 使用 context 级别监听（捕获所有 page 的请求，包括弹出的新标签页）
  context.on('request', async (request) => {
    const url = request.url();
    if (request.method() === 'OPTIONS') return;

    const isSend = isSendRequest(url);
    const isToken = isTokenRequest(url);
    if (!isSend && !isToken) return;

    const tag = isSend ? '[捕获-send]' : '[捕获-token]';
    log.info(`${tag} ${request.method()} ${url}`);

    let bodyBase64 = '';
    let bodyHex = '';
    let bodySize = 0;
    try {
      const bodyBuffer = request.postDataBuffer();
      if (bodyBuffer) {
        bodyBase64 = bodyBuffer.toString('base64');
        bodyHex = bodyBuffer.toString('hex');
        bodySize = bodyBuffer.length;
        log.info(`${tag} 请求体: ${bodySize} 字节`);
        if (isToken) {
          log.info(`${tag} 请求体内容: ${bodyBuffer.toString('utf-8').slice(0, 500)}`);
        } else {
          log.debug(`${tag} 请求体 hex(前200): ${bodyHex.slice(0, 200)}`);
        }
      }
    } catch (e) {
      log.warn(`${tag} 读取请求体失败: ${e}`);
    }

    const headers: Record<string, string> = {};
    try {
      const allHeaders = await request.allHeaders();
      Object.assign(headers, sanitizeHeaders(allHeaders));
    } catch (e) {
      log.warn(`${tag} 读取请求头失败: ${e}`);
    }

    const entry: CapturedRequest = {
      timestamp: new Date().toISOString(),
      request: {
        url,
        method: request.method(),
        headers,
        bodyBase64,
        bodyHex,
        bodySize,
      },
      response: null,
    };

    if (isSend) captured.push(entry);
    else tokenCaptured.push(entry);
  });

  // 监听响应
  context.on('response', async (response) => {
    const url = response.url();
    const isSend = isSendRequest(url);
    const isToken = isTokenRequest(url);
    if (!isSend && !isToken) return;

    const req = response.request();
    if (req.method() === 'OPTIONS') return;

    const tag = isSend ? '[捕获-send]' : '[捕获-token]';
    log.info(`${tag} 响应 status=${response.status()} ${url}`);

    try {
      const respBodyBuffer = await response.body();
      const respBodyBase64 = respBodyBuffer.toString('base64');
      const respBodySize = respBodyBuffer.length;
      log.info(`${tag} 响应体: ${respBodySize} 字节`);
      if (respBodySize > 0) {
        if (isToken) {
          // token 响应直接打印文本内容（JSON）
          log.info(`${tag} 响应内容: ${respBodyBuffer.toString('utf-8').slice(0, 800)}`);
        } else {
          log.debug(`${tag} 响应体 hex(前200): ${respBodyBuffer.toString('hex').slice(0, 200)}`);
        }
      }

      const respHeaders: Record<string, string> = {};
      try {
        const allHeaders = await response.allHeaders();
        for (const [k, v] of Object.entries(allHeaders)) {
          respHeaders[k] = v;
        }
      } catch {
        // 忽略
      }

      // 找到对应的请求记录，补充响应
      const list = isSend ? captured : tokenCaptured;
      const lastCapture = list[list.length - 1];
      if (lastCapture && !lastCapture.response) {
        lastCapture.response = {
          status: response.status(),
          statusText: response.statusText(),
          headers: respHeaders,
          bodyBase64: respBodyBase64,
          bodySize: respBodySize,
        };
      }

      // 每捕获到响应就立即保存一份（防止用户突然关闭）
      await saveCaptures(captured);
      if (tokenCaptured.length > 0) await saveTokenCaptures(tokenCaptured);
      log.info(`${tag} 已保存（send=${captured.length}, token=${tokenCaptured.length}）`);
    } catch (e) {
      log.warn(`${tag} 读取响应体失败: ${e}`);
    }
  });

  // 额外：记录所有 imapi.douyin.com 请求（帮助理解完整请求流）
  context.on('request', (request) => {
    const url = request.url();
    if (url.includes('imapi.douyin.com') && !isSendRequest(url) && !isTokenRequest(url)) {
      log.debug(`[imapi] ${request.method()} ${url.slice(0, 120)}`);
    }
  });

  // 导航到抖音私信页
  log.info('导航到 https://www.douyin.com/chat');
  await page.goto('https://www.douyin.com/chat', {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  log.info('');
  log.info('═══════════════════════════════════════════════════════════════');
  log.info(' 浏览器已打开，请在页面中手动发送一条消息给任意联系人');
  log.info(' 工具会自动捕获以下请求并保存：');
  log.info('   - /v1/message/send         消息发送请求（含签名参数）');
  log.info('   - identity_security_token   安全令牌请求（含正确端点和参数）');
  log.info(` 超时: ${Math.floor(timeoutMs / 1000)} 秒`);
  log.info(' 完成后按 Ctrl+C 退出（捕获结果已自动保存）');
  log.info('═══════════════════════════════════════════════════════════════');
  log.info('');

  // 等待超时或用户 Ctrl+C
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      log.info(`超时 ${Math.floor(timeoutMs / 1000)} 秒，结束抓包`);
      resolve();
    }, timeoutMs);

    process.once('SIGINT', () => {
      clearTimeout(timer);
      log.info('收到 Ctrl+C，结束抓包');
      resolve();
    });
  });

  // 最终保存一次
  await saveCaptures(captured);
  if (tokenCaptured.length > 0) await saveTokenCaptures(tokenCaptured);

  try {
    await browser.close();
  } catch {
    // 忽略
  }

  return captured;
}

/** 保存抓包结果到文件 */
async function saveCaptures(captured: CapturedRequest[]): Promise<void> {
  if (captured.length === 0) return;

  await fs.mkdir(CAPTURE_DIR, { recursive: true });

  // 按时间戳保存每个请求
  for (let i = 0; i < captured.length; i++) {
    const c = captured[i];
    const ts = c.timestamp.replace(/[:.]/g, '-');
    const filename = `send-${ts}-${i + 1}.json`;
    const filepath = path.join(CAPTURE_DIR, filename);

    // 解析 bodyHex 为可读格式（protobuf 字段预览）
    const analysis = analyzeRequestBody(c.request.bodyHex);

    const output = {
      timestamp: c.timestamp,
      request: c.request,
      response: c.response,
      analysis,
    };

    await fs.writeFile(filepath, JSON.stringify(output, null, 2), 'utf-8');
    log.info(`[保存] ${filepath}`);
  }

  // 同时保存一个汇总文件
  const summaryPath = path.join(CAPTURE_DIR, 'last-capture-summary.json');
  const summary = captured.map((c, i) => ({
    index: i + 1,
    timestamp: c.timestamp,
    url: c.request.url,
    method: c.request.method,
    bodySize: c.request.bodySize,
    responseStatus: c.response?.status,
    responseSize: c.response?.bodySize,
    analysis: analyzeRequestBody(c.request.bodyHex),
  }));
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
  log.info(`[保存] 汇总文件: ${summaryPath}`);
}

/** 保存 identity_security_token 抓包结果到文件 */
async function saveTokenCaptures(captured: CapturedRequest[]): Promise<void> {
  if (captured.length === 0) return;

  await fs.mkdir(CAPTURE_TOKEN_DIR, { recursive: true });

  // 按时间戳保存每个请求
  for (let i = 0; i < captured.length; i++) {
    const c = captured[i];
    const ts = c.timestamp.replace(/[:.]/g, '-');
    const filename = `token-${ts}-${i + 1}.json`;
    const filepath = path.join(CAPTURE_TOKEN_DIR, filename);

    // token 请求是 JSON，直接解析为可读格式
    const reqBody = c.request.bodySize > 0 ? Buffer.from(c.request.bodyBase64, 'base64').toString('utf-8') : '';
    const respBody = c.response && c.response.bodySize > 0
      ? Buffer.from(c.response.bodyBase64, 'base64').toString('utf-8')
      : '';

    const output = {
      timestamp: c.timestamp,
      request: {
        url: c.request.url,
        method: c.request.method,
        headers: c.request.headers,
        body: reqBody,
      },
      response: c.response
        ? {
            status: c.response.status,
            headers: c.response.headers,
            body: respBody,
          }
        : null,
    };

    await fs.writeFile(filepath, JSON.stringify(output, null, 2), 'utf-8');
    log.info(`[保存] ${filepath}`);
  }

  // 同时保存一个汇总文件
  const summaryPath = path.join(CAPTURE_TOKEN_DIR, 'last-capture-summary.json');
  const summary = captured.map((c, i) => ({
    index: i + 1,
    timestamp: c.timestamp,
    url: c.request.url,
    method: c.request.method,
    responseStatus: c.response?.status,
    responsePreview: c.response && c.response.bodySize > 0
      ? Buffer.from(c.response.bodyBase64, 'base64').toString('utf-8').slice(0, 300)
      : '',
  }));
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
  log.info(`[保存] token 汇总文件: ${summaryPath}`);
}

/**
 * 简单分析 protobuf 请求体（hex 字符串）
 * 提取可读的字符串片段，帮助识别请求结构
 */
function analyzeRequestBody(hexStr: string): {
  size: number;
  readableStrings: string[];
  preview: string;
} {
  if (!hexStr) {
    return { size: 0, readableStrings: [], preview: '' };
  }

  const buffer = Buffer.from(hexStr, 'hex');
  const size = buffer.length;

  // 提取可读字符串（长度 >= 4 的 ASCII 字符串）
  const readableStrings: string[] = [];
  let current = '';
  for (const byte of buffer) {
    if (byte >= 0x20 && byte < 0x7f) {
      current += String.fromCharCode(byte);
    } else {
      if (current.length >= 4) {
        readableStrings.push(current);
      }
      current = '';
    }
  }
  if (current.length >= 4) readableStrings.push(current);

  // hex 预览（前 200 字符）
  const preview = hexStr.slice(0, 200);

  return {
    size,
    readableStrings: readableStrings.slice(0, 20), // 最多 20 个
    preview,
  };
}
