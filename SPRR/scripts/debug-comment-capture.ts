#!/usr/bin/env tsx
/**
 * 评论功能全量抓包调试脚本（API 更新分析用）
 *
 * 用途：
 *   评论相关 API 变更后，捕获浏览器端真实评论请求全量数据，用于：
 *   - 对比 /aweme/v1/web/comment/publish 的 query 参数、headers、body 与脚本实现的差异
 *   - 跟踪 /aweme/v1/web/comment/* 其他接口（list / reply 等）参数变化
 *   - 快照原生请求的公共环境参数（webid / uifid / version_code 等）
 *
 * 捕获范围：
 *   1. www.douyin.com/aweme/v1/web/comment/* 全部（query/headers/body/响应全量保存）
 *   2. www.douyin.com/aweme/v1/web/aweme/detail/（视频详情，评论前置请求）
 *   3. 其余 www.douyin.com/aweme/v1/web/* 请求：按参数名快照"首次出现值"（环境参数对照）
 *
 * 保存结构（实时写盘，突然关闭浏览器也不丢数据）：
 *   data/capture/comment/debug-comment-<时间戳>/
 *     ├── summary.json          会话汇总（含 publish 专项：query/headers/body/响应）
 *     ├── console.log           浏览器 console（NDJSON，每行一条）
 *     └── http/
 *         └── 001-POST-comment-publish.json   每个请求/响应对一个文件
 *
 * 使用流程：
 *   1. npx tsx scripts/debug-comment-capture.ts [--account <name>] [--timeout <分钟>]
 *   2. 浏览器自动打开（已登录态），人工导航到目标视频并发布一条评论
 *   3. 操作完成后直接关闭浏览器窗口，脚本自动保存汇总并退出（Ctrl+C 亦可）
 *   4. 分析 data/capture/comment/debug-comment-<时间戳>/ 下的文件
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================ 路径与常量 ============================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ACCOUNTS_DIR = path.join(PROJECT_ROOT, 'data', 'accounts');
const CAPTURE_ROOT = path.join(PROJECT_ROOT, 'data', 'capture', 'comment');

const HOME_URL = 'https://www.douyin.com/';
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const WEB_ORIGIN = 'https://www.douyin.com';

/** 默认抓包时长上限（分钟），用户关闭浏览器即提前结束 */
const DEFAULT_TIMEOUT_MIN = 30;

// ============================ 参数解析 ============================

function getArgValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  return undefined;
}

// ============================ 会话状态 ============================

interface HttpEntry {
  index: number;
  timestamp: string;
  url: string;
  method: string;
  path: string;
  query: Record<string, string>;
  reqHeaders: Record<string, string>;
  reqBodyText: string;
  reqBodySize: number;
  respStatus?: number;
  respHeaders?: Record<string, string>;
  respBodyText?: string;
  respBodySize?: number;
  error?: string;
  saved: boolean;
}

/** 脱敏 headers 中的敏感 cookie 值 */
function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'cookie' && typeof v === 'string') {
      out[k] = v.replace(
        /(sessionid|sessionid_ss|ssid|passport_csrf_token|s_v_web_id|msToken|ttwid)=([^;]{8})[^;]*/gi,
        (_, name, prefix) => `${name}=***`,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 是否为需要全量捕获的评论相关 URL */
function captureKind(url: string): 'comment' | 'detail' | null {
  if (/\.(js|mjs|css|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|mp4|mpd|m3u8|ts)(\?|$)/i.test(url)) return null;
  if (!url.startsWith(WEB_ORIGIN)) return null;
  const u = new URL(url);
  if (u.pathname.startsWith('/aweme/v1/web/comment/')) return 'comment';
  if (u.pathname === '/aweme/v1/web/aweme/detail/') return 'detail';
  return null;
}

/** 请求体（urlencoded form / JSON / 文本）→ 可读字段 */
function parseBodyText(text: string, contentType: string): Record<string, string> | undefined {
  if (!text) return undefined;
  try {
    if (contentType.includes('application/x-www-form-urlencoded')) {
      return Object.fromEntries(new URLSearchParams(text).entries());
    }
    if (contentType.includes('json')) return { _json: JSON.stringify(JSON.parse(text)) };
  } catch {
    // fallthrough
  }
  return { _raw: text.slice(0, 4000) };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 定位账号 storageState */
async function locateStorageState(account?: string): Promise<string> {
  if (account) {
    const p = path.join(ACCOUNTS_DIR, `${account}.json`);
    if (await exists(p)) return p;
    throw new Error(`账号 ${account} 不存在（找不到 ${p}）`);
  }
  try {
    const current = (await fs.readFile(path.join(ACCOUNTS_DIR, 'current'), 'utf-8')).trim();
    if (current) {
      const p = path.join(ACCOUNTS_DIR, `${current}.json`);
      if (await exists(p)) return p;
    }
  } catch {
    // 忽略，走兜底
  }
  throw new Error('未找到已登录账号，请先运行 sprr login 登录');
}

// ============================ 主流程 ============================

async function main() {
  const accountArg = getArgValue('account');
  const timeoutMin = Number(getArgValue('timeout') ?? DEFAULT_TIMEOUT_MIN);
  const targetUrl = getArgValue('url') ?? HOME_URL;
  const accountName = accountArg
    ?? (await fs.readFile(path.join(ACCOUNTS_DIR, 'current'), 'utf-8')).trim();

  const storageState = await locateStorageState(accountArg);
  // 记录原账号 uid，结束时回写 storageState 前校验未被切换账号
  const original = JSON.parse(await fs.readFile(storageState, 'utf-8')) as {
    cookies?: Array<{ name: string; value: string }>;
  };
  const originalUid = original.cookies?.find((c) => c.name === 'uid_tt')?.value ?? '';

  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate(),
  ).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(
    now.getMinutes(),
  ).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const sessionDir = path.join(CAPTURE_ROOT, `debug-comment-${stamp}`);
  const httpDir = path.join(sessionDir, 'http');
  await fs.mkdir(httpDir, { recursive: true });

  const httpEntries: HttpEntry[] = [];
  const pendingEntries: Array<{ reqObj: object; entry: HttpEntry }> = [];
  const lateResponses = new Map<string, LateResponse>();
  /** 其余 /aweme/v1/web/* 请求的参数快照（每参数名首次出现值） */
  const envParamSnapshot: Record<string, string> = {};

  interface LateResponse {
    status: number;
    headers: Record<string, string>;
    bodyText: string;
    bodySize: number;
    error?: string;
  }

  const consoleFile = path.join(sessionDir, 'console.log');

  console.log(`╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║          抖音评论 API 调试抓包（有头窗口，人工操作）          ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝`);
  console.log(`  账号:         ${accountName}`);
  console.log(`  storageState: ${storageState}`);
  console.log(`  保存目录:     ${sessionDir}`);
  console.log(`  超时上限:     ${timeoutMin} 分钟（关闭浏览器即提前结束）`);
  console.log();

  const { chromium: chromiumMod } = await import('playwright');
  const browser = await chromiumMod.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--window-size=1400,900'],
  });
  const context = await browser.newContext({
    storageState,
    userAgent: DEFAULT_UA,
    viewport: null,
    screen: { width: 1400, height: 900 },
    locale: 'zh-CN',
  });
  await context.addInitScript(
    "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });",
  );

  // ---------- HTTP 捕获（context 级，覆盖所有标签页） ----------
  function takePendingEntry(reqObj: object, url: string, method: string): HttpEntry | null {
    for (let i = 0; i < pendingEntries.length; i++) {
      if (pendingEntries[i].reqObj === reqObj && !pendingEntries[i].entry.saved) {
        return pendingEntries.splice(i, 1)[0].entry;
      }
    }
    for (let i = pendingEntries.length - 1; i >= 0; i--) {
      const p = pendingEntries[i];
      if (!p.entry.saved && p.entry.url === url && p.entry.method === method) {
        return pendingEntries.splice(i, 1)[0].entry;
      }
    }
    return null;
  }

  async function readResponseData(response: import('playwright').Response): Promise<LateResponse> {
    const late: LateResponse = {
      status: response.status(),
      headers: {},
      bodyText: '',
      bodySize: 0,
    };
    try {
      late.headers = sanitizeHeaders(await response.allHeaders());
    } catch {
      // 忽略
    }
    try {
      const buf = await response.body();
      late.bodySize = buf.length;
      late.bodyText = buf.toString('utf-8');
    } catch (e) {
      late.error = `resp-body-read-fail: ${e}`;
    }
    return late;
  }

  async function attachResponse(entry: HttpEntry, late: LateResponse): Promise<void> {
    entry.respStatus = late.status;
    entry.respHeaders = late.headers;
    entry.respBodyText = late.bodyText;
    entry.respBodySize = late.bodySize;
    if (late.error) entry.error = late.error;
    await saveHttpEntry(entry, sessionDir);
    console.log(`[HTTP #${entry.index}] ← ${late.status} ${late.bodySize}B 已保存`);
    if (entry.path.startsWith('/aweme/v1/web/comment/publish')) {
      console.log(`  ★ publish 响应: ${late.bodyText.slice(0, 400)}`);
    }
  }

  context.on('request', async (request) => {
    try {
      const url = request.url();
      if (request.method() === 'OPTIONS') return;
      const kind = captureKind(url);
      if (!kind) {
        // 非评论接口：仅快照 /aweme/v1/web/* 的参数名（用于环境参数对照）
        if (url.startsWith(WEB_ORIGIN) && new URL(url).pathname.startsWith('/aweme/v1/web/')) {
          for (const [k, v] of new URL(url).searchParams.entries()) {
            if (!(k in envParamSnapshot)) envParamSnapshot[k] = v.slice(0, 80);
          }
        }
        return;
      }

      const u = new URL(url);
      const query: Record<string, string> = {};
      for (const [k, v] of u.searchParams.entries()) query[k] = v;

      let bodyText = '';
      try {
        bodyText = request.postData() ?? '';
      } catch {
        // 无 body
      }

      const entry: HttpEntry = {
        index: httpEntries.length + 1,
        timestamp: new Date().toISOString(),
        url,
        method: request.method(),
        path: u.pathname,
        query,
        reqHeaders: {},
        reqBodyText: bodyText,
        reqBodySize: Buffer.byteLength(bodyText),
        saved: false,
      };
      httpEntries.push(entry);
      pendingEntries.push({ reqObj: request as unknown as object, entry });

      const contentType = String(request.headers()['content-type'] ?? '');
      console.log(
        `[HTTP #${entry.index}] ${entry.method} ${u.pathname}${contentType ? ` (${contentType.split(';')[0]})` : ''}`,
      );

      try {
        entry.reqHeaders = sanitizeHeaders(await request.allHeaders());
      } catch {
        // 忽略
      }

      const lateKey = `${url}|${entry.method}`;
      const late = lateResponses.get(lateKey);
      if (late) {
        lateResponses.delete(lateKey);
        await attachResponse(entry, late);
      }
    } catch (e) {
      console.warn(`[HTTP 捕获异常] ${e}`);
    }
  });

  context.on('response', async (response) => {
    try {
      const url = response.url();
      const req = response.request();
      if (req.method() === 'OPTIONS') return;
      if (!captureKind(url)) return;

      const entry = takePendingEntry(req as unknown as object, url, req.method());
      const late = await readResponseData(response);
      if (entry && !entry.saved) {
        await attachResponse(entry, late);
      } else if (!entry) {
        lateResponses.set(`${url}|${req.method()}`, late);
      }
    } catch (e) {
      console.warn(`[HTTP 响应捕获异常] ${e}`);
    }
  });

  context.on('requestfailed', async (request) => {
    try {
      const entry = takePendingEntry(request as unknown as object, request.url(), request.method());
      if (!entry || entry.saved) return;
      entry.error = `requestfailed: ${request.failure()?.errorText ?? 'unknown'}`;
      await saveHttpEntry(entry, sessionDir);
      console.log(`[HTTP #${entry.index}] ✗ 请求失败 ${entry.error}`);
    } catch {
      // 忽略
    }
  });

  // ---------- 浏览器 console 捕获 ----------
  context.on('page', (page) => {
    page.on('console', (msg) => {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        const line = JSON.stringify({ ts: new Date().toISOString(), type, text: msg.text() });
        void fs.appendFile(consoleFile, line + '\n', 'utf-8');
      }
    });
    page.on('pageerror', (err) => {
      const line = JSON.stringify({ ts: new Date().toISOString(), type: 'pageerror', text: err.message });
      void fs.appendFile(consoleFile, line + '\n', 'utf-8');
    });
  });

  // ---------- 打开页面 ----------
  const page = await context.newPage();
  console.log(`导航到 ${targetUrl} ...`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  console.log();
  console.log(`═══════════════════════════════════════════════════════════════`);
  console.log(` 浏览器窗口已打开（账号 ${accountName}），请人工操作：`);
  console.log(`   1. 导航到要评论的视频页（可搜索/粘贴视频链接）`);
  console.log(`   2. 在评论区发布一条评论（或回复某条评论）`);
  console.log(`   3. 若弹出验证码/登录提示，请直接在窗口内完成`);
  console.log(` 任意请求异常也会被完整记录。`);
  console.log(`═══════════════════════════════════════════════════════════════`);
  console.log(` 操作完成后【直接关闭浏览器窗口】即可，脚本会自动保存并退出`);
  console.log(` （也可以在终端按 Ctrl+C 结束；数据实时落盘，中途关也不丢）`);
  console.log();

  // ---------- 等待结束 ----------
  let finished = false;
  let endReason = '';

  const finish = async (reason: string) => {
    if (finished) return;
    finished = true;
    endReason = reason;
    console.log(`\n结束抓包（原因: ${reason}），正在保存汇总...`);

    for (const entry of httpEntries) {
      if (!entry.saved) await saveHttpEntry(entry, sessionDir);
    }

    // publish 专项汇总（正文/参数/头 + 响应），供与脚本实现逐项对比
    const publishes = httpEntries.filter((e) => e.path.startsWith('/aweme/v1/web/comment/'));
    const publishSummary = publishes.map((e) => ({
      method: e.method,
      path: e.path,
      timestamp: e.timestamp,
      query: e.query,
      headers: e.reqHeaders,
      body: e.reqBodyText
        ? parseBodyText(e.reqBodyText, String(e.reqHeaders['content-type'] ?? e.reqHeaders['Content-Type'] ?? ''))
        : undefined,
      bodyRaw: e.reqBodyText || undefined,
      response: e.respStatus
        ? { status: e.respStatus, body: (e.respBodyText ?? '').slice(0, 8000) }
        : undefined,
      error: e.error,
    }));

    const summary = {
      sessionStart: now.toISOString(),
      sessionEnd: new Date().toISOString(),
      endReason,
      account: accountName,
      storageState,
      targetUrl,
      commentRequests: httpEntries
        .filter((e) => e.path.startsWith('/aweme/v1/web/comment/'))
        .map((e) => ({ file: `http/${httpFileName(e)}`, method: e.method, path: e.path, httpStatus: e.respStatus })),
      detailRequests: httpEntries
        .filter((e) => e.path === '/aweme/v1/web/aweme/detail/')
        .map((e) => ({ file: `http/${httpFileName(e)}`, httpStatus: e.respStatus })),
      publish: publishSummary,
      envParamSnapshot,
    };
    await fs.writeFile(path.join(sessionDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8');

    // 会话内若人工重新登录/刷新了登录态，回写 storageState（仅当账号未变）
    if (reason !== 'ctrl-c') {
      try {
        const state = await context.storageState();
        const uid = state.cookies.find((c) => c.name === 'uid_tt')?.value ?? '';
        const hasSession = state.cookies.some(
          (c) => (c.name === 'sessionid' || c.name === 'sessionid_ss') && c.value,
        );
        if (hasSession && (!originalUid || uid === originalUid)) {
          await fs.writeFile(storageState, JSON.stringify(state, null, 2), 'utf-8');
          console.log(`登录态已回写: ${storageState}`);
        } else if (hasSession && uid !== originalUid) {
          console.log(`检测到窗口内登录了其他账号（uid 变化），不回写 ${storageState}`);
        }
      } catch {
        // 浏览器可能已被关闭
      }
    }

    console.log();
    console.log(`═══════════════════════════════════════════════════════════════`);
    console.log(` 抓包完成，数据已保存到: ${sessionDir}`);
    console.log(`   评论相关请求: ${httpEntries.filter((e) => e.path.startsWith('/aweme/v1/web/comment/')).length} 个`);
    if (publishSummary.length > 0) {
      console.log(`   ★ 已捕获 publish，可在 summary.json 的 publish 字段逐项对比`);
    } else {
      console.log(`   本轮未捕获到 comment/publish 请求`);
    }
    console.log(`═══════════════════════════════════════════════════════════════`);

    try {
      await browser.close();
    } catch {
      // 已关闭
    }
    process.exit(0);
  };

  browser.on('disconnected', () => void finish('browser-closed'));
  process.once('SIGINT', () => void finish('ctrl-c'));
  const timer = setTimeout(() => void finish('timeout'), timeoutMin * 60 * 1000);
  timer.unref?.();
}

// ============================ 落盘 ============================

function httpFileName(e: HttpEntry): string {
  const parts: string[] = [String(e.index).padStart(3, '0'), e.method];
  const p = e.path.replace(/^\//, '').replace(/[/?&=]/g, '-').slice(0, 60);
  if (p) parts.push(p);
  return `${parts.join('_')}.json`;
}

async function saveHttpEntry(entry: HttpEntry, sessionDir: string): Promise<void> {
  if (entry.saved) return;
  entry.saved = true;
  const output = {
    index: entry.index,
    timestamp: entry.timestamp,
    request: {
      url: entry.url,
      method: entry.method,
      path: entry.path,
      query: entry.query,
      headers: entry.reqHeaders,
      bodySize: entry.reqBodySize,
      bodyRaw: entry.reqBodyText,
      bodyFields: entry.reqBodyText
        ? parseBodyText(entry.reqBodyText, String(entry.reqHeaders['content-type'] ?? ''))
        : undefined,
    },
    response: entry.respStatus
      ? {
          status: entry.respStatus,
          headers: entry.respHeaders,
          bodySize: entry.respBodySize,
          body: entry.respBodyText?.slice(0, 100_000),
        }
      : null,
    error: entry.error,
  };
  const filepath = path.join(sessionDir, 'http', httpFileName(entry));
  await fs.writeFile(filepath, JSON.stringify(output, null, 2), 'utf-8');
}

main().catch((e) => {
  console.error('脚本执行失败:', e);
  process.exit(1);
});
