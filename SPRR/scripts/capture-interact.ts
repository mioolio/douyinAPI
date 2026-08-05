#!/usr/bin/env tsx
/**
 * 抖音社交互动抓包脚本（多功能）
 *
 * 专用于抓取「通知回复 @ / 发布评论 / 转发分享 / @好友」流程的 API。
 *
 * 保存内容：
 *   data/capture/interact/requests/   所有互动相关请求（含请求+响应完整数据）
 *   data/capture/interact/summary.json  请求摘要（URL + 方法 + 状态 + 分类 + 高亮参数）
 *
 * 用法（一键启动，无需参数）：
 *   npx tsx scripts/capture-interact.ts
 *
 * 可选参数：
 *   npx tsx scripts/capture-interact.ts --state <path>     指定其他账号 storageState
 *   npx tsx scripts/capture-interact.ts --url <url>        指定起始 URL（默认抖音首页）
 *
 * 操作流程（在浏览器中人工操作，终端实时输出捕获的 API）：
 *   场景 1：通知回复 @
 *     - 用小号在某视频评论区 @ 你（小号操作，不在本浏览器）
 *     - 在本浏览器（大号）点击通知图标 → 找到 @ 你的通知 → 点击进入
 *     - 在评论区回复小号的 @（触发 comment/reply 或 comment/publish）
 *
 *   场景 2：发布评论
 *     - 随便播放一个视频
 *     - 滚动到评论区，输入评论内容并发送（触发 comment/publish）
 *
 *   场景 3：转发分享
 *     - 随便播放一个视频
 *     - 点击分享按钮 → 选择「私信」→ 选择好友 → 发送（触发 IM send_message + 分享接口）
 *     - 或点击分享按钮 → 复制链接（触发 share 相关接口）
 *
 *   场景 4：@好友
 *     - 随便播放一个视频
 *     - 点击分享 → 私信 → 在输入框 @ 好友（触发 user/search 或 at 相关接口）
 *     - 或在评论区 @ 好友
 *
 * 操作完毕后关闭浏览器或按 Ctrl+C，数据自动保存。
 */

import { chromium, type Request, type Response } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const log = (scope: string, msg: string) =>
  process.stderr.write(`[${new Date().toISOString()}] [${scope}] ${msg}\n`);

// ============== 参数解析 ==============
const args = process.argv.slice(2);
const getArg = (name: string, def: string) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
};

// 默认打开抖音首页（不指定 modal_id，让用户自由浏览/播放视频）
const TARGET_URL = getArg('url', 'https://www.douyin.com/');
// 默认使用项目自身的 storageState（与 CLI 命令一致，即当前账号 default）
const STORAGE_STATE = getArg(
  'state',
  path.resolve(__dirname, '..', 'data', 'accounts', 'default.json'),
);

// ============== 输出目录 ==============
const CAPTURE_DIR = path.resolve(__dirname, '..', 'data', 'capture', 'interact');
const REQ_DIR = path.join(CAPTURE_DIR, 'requests');
const SUMMARY_FILE = path.join(CAPTURE_DIR, 'summary.json');

// ============== 互动相关 API 关键词 ==============
// 覆盖：评论、通知、分享/转发、@好友、视频详情、用户信息、私信发送
const INTERACT_KEYWORDS = [
  // 评论核心接口
  '/comment/',
  'comment/list',
  'comment/publish',
  'comment/reply',
  'comment/delete',
  'comment/digg',
  'comment/like',
  // 通知接口
  '/notice/',
  'notice/count',
  // 分享/转发
  '/share/',
  'share/video',
  'share_content',
  'forward',
  // @好友 / 搜索用户
  '/user/at',
  'at_list',
  'search/user',
  'user/search',
  // 视频详情
  '/aweme/detail',
  '/multi/aweme/detail',
  // 用户信息（点头像/@时触发）
  '/user/profile',
  '/aweme/v1/web/user/',
  // 私信相关（分享视频到私信时触发）
  '/aweme/v1/web/im/',
  'send_message',
  // 通用 aweme 路径（作品相关）
  '/aweme/v1/web/',
];

// endpoint 分类（便于后续分析）
const ENDPOINT_CATEGORIES: Array<{ pattern: RegExp; category: string }> = [
  // 视频详情
  { pattern: /\/aweme\/v1\/web\/aweme\/detail/, category: 'aweme_detail' },
  { pattern: /\/aweme\/v1\/web\/multi\/aweme\/detail/, category: 'aweme_detail' },
  // 评论
  { pattern: /\/aweme\/v1\/web\/comment\/list/, category: 'comment_list' },
  { pattern: /\/aweme\/v1\/web\/comment\/publish/, category: 'comment_publish' },
  { pattern: /\/aweme\/v1\/web\/comment\/reply/, category: 'comment_reply' },
  { pattern: /\/aweme\/v1\/web\/comment\/delete/, category: 'comment_delete' },
  { pattern: /\/aweme\/v1\/web\/comment\/digg/, category: 'comment_like' },
  { pattern: /\/aweme\/v1\/web\/comment\//, category: 'comment_other' },
  // 通知
  { pattern: /\/aweme\/v1\/web\/notice\//, category: 'notice' },
  // 分享/转发
  { pattern: /\/aweme\/v1\/web\/share\//, category: 'share' },
  { pattern: /\/aweme\/v1\/web\/forward\//, category: 'forward' },
  // 用户搜索 / @好友
  { pattern: /\/aweme\/v1\/web\/user\/search/, category: 'user_search' },
  { pattern: /\/aweme\/v1\/web\/general\/search/, category: 'user_search' },
  { pattern: /\/aweme\/v1\/web\/user\/at/, category: 'user_at' },
  // 用户资料
  { pattern: /\/aweme\/v1\/web\/user\/profile/, category: 'user_profile' },
  { pattern: /\/aweme\/v1\/web\/user\//, category: 'user_info' },
  // 私信（分享视频到私信）
  { pattern: /\/aweme\/v1\/web\/im\//, category: 'im' },
];

// 关键 query 参数（用于摘要高亮，便于逆向分析）
const INTERESTING_QUERY_PARAMS = [
  'a_bogus',
  'msToken',
  'verifyFp',
  'fp',
  'webid',
  'aweme_id',
  'item_id',
  'comment_id',
  'reply_id',
  'reply_comment_id',
  'cid',
  'text',
  'content',
  'at_user_id',
  'to_user_id',
  'share_user_id',
  'target_uid',
  'conversation_short_id',
  'device_platform',
  'aid',
  'channel',
];

// ============== 状态 ==============
let reqCounter = 0;
const summary: Array<Record<string, unknown>> = [];

// ============== 工具函数 ==============
function isInteractApi(url: string): boolean {
  try {
    const u = new URL(url);
    const full = u.pathname + u.search;
    return INTERACT_KEYWORDS.some((kw) => full.includes(kw));
  } catch {
    return false;
  }
}

function categorizeEndpoint(url: string): string | null {
  try {
    const u = new URL(url);
    for (const { pattern, category } of ENDPOINT_CATEGORIES) {
      if (pattern.test(u.pathname)) return category;
    }
    return null;
  } catch {
    return null;
  }
}

function extractQueryHighlights(url: string): Record<string, string> {
  const highlights: Record<string, string> = {};
  try {
    const u = new URL(url);
    for (const key of INTERESTING_QUERY_PARAMS) {
      const val = u.searchParams.get(key);
      if (val) highlights[key] = val;
    }
  } catch {
    // ignore
  }
  return highlights;
}

function safeFilename(url: string, method: string, index: number): string {
  const u = (() => {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  })();
  const pathPart = u ? u.pathname.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40) : 'unknown';
  const hash = crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
  return `${String(index).padStart(4, '0')}_${method}_${pathPart}_${hash}.json`;
}

// ============== 保存逻辑 ==============
async function saveRequestPair(req: Request, res: Response | null) {
  reqCounter++;
  const ts = new Date().toISOString();
  const url = req.url();
  const method = req.method();
  const reqHeaders = await req.allHeaders();
  const reqBody = req.postData() || null;
  const reqContentType = reqHeaders['content-type'] || '';

  // 响应
  let resStatus = 0;
  let resHeaders: Record<string, string> = {};
  let resBody: string | null = null;
  let resContentType = '';
  let resSize = 0;

  if (res) {
    resStatus = res.status();
    resHeaders = await res.allHeaders();
    resContentType = resHeaders['content-type'] || '';
    try {
      const buf = await res.body();
      resSize = buf.length;
      const isText =
        resContentType.includes('json') ||
        resContentType.includes('text') ||
        resContentType.includes('javascript') ||
        resContentType.includes('xml') ||
        resContentType.includes('form-');
      resBody = isText ? buf.toString('utf-8') : `[binary ${buf.length} bytes, content-type=${resContentType}]`;
    } catch (e) {
      resBody = `[BODY_READ_ERROR: ${(e as Error).message}]`;
    }
  }

  const category = categorizeEndpoint(url);
  const highlights = extractQueryHighlights(url);

  const record = {
    ts,
    index: reqCounter,
    category,
    highlights,
    request: {
      method,
      url,
      headers: reqHeaders,
      body: reqBody,
      contentType: reqContentType,
    },
    response: res
      ? {
          status: resStatus,
          headers: resHeaders,
          body: resBody,
          contentType: resContentType,
          size: resSize,
        }
      : null,
  };

  // 保存完整记录
  const filename = safeFilename(url, method, reqCounter);
  await fs.writeFile(path.join(REQ_DIR, filename), JSON.stringify(record, null, 2), 'utf-8');

  // 更新摘要
  summary.push({
    index: reqCounter,
    ts,
    method,
    url,
    status: resStatus,
    size: resSize,
    category,
    highlights,
    file: filename,
  });
  // 增量写盘（避免直接关浏览器丢数据）
  await fs.writeFile(SUMMARY_FILE, JSON.stringify(summary, null, 2), 'utf-8');

  // 终端实时输出
  const catTag = category ? `[${category}]` : '';
  const hlTag = Object.keys(highlights).length > 0 ? ` ${JSON.stringify(highlights)}` : '';
  log('api', `#${reqCounter} ${method} ${resStatus} ${url.slice(0, 120)} ${catTag}${hlTag}`);
}

// ============== 反检测脚本 ==============
const stealthInitScript = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
window.chrome = { runtime: {} };
`;

// ============== 主流程 ==============
async function main() {
  // 准备目录
  await fs.mkdir(REQ_DIR, { recursive: true });

  log('capture-interact', '========================================================');
  log('capture-interact', '抖音社交互动抓包脚本（多功能）');
  log('capture-interact', `保存目录: ${CAPTURE_DIR}`);
  log('capture-interact', `storageState: ${STORAGE_STATE}`);
  log('capture-interact', `起始 URL: ${TARGET_URL}`);
  log('capture-interact', '========================================================');

  let storageStateExists = true;
  try {
    await fs.access(STORAGE_STATE);
  } catch {
    storageStateExists = false;
    log('capture-interact', '警告: storageState 不存在，将打开未登录状态');
  }

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--window-size=1400,900',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    storageState: storageStateExists ? STORAGE_STATE : undefined,
  });

  await context.addInitScript(stealthInitScript);

  const page = await context.newPage();

  // 监听响应（请求-响应对在 response 事件里一次性保存）
  page.on('response', async (res) => {
    const req = res.request();
    const rt = req.resourceType();
    // 过滤静态资源
    if (rt === 'image' || rt === 'media' || rt === 'font' || rt === 'manifest') {
      return;
    }
    const url = req.url();
    // 只保存互动相关 API
    if (!isInteractApi(url)) return;
    try {
      await saveRequestPair(req, res);
    } catch (e) {
      log('error', `保存失败: ${(e as Error).message} url=${url.slice(0, 100)}`);
    }
  });

  // 未配对的请求（如被取消的）
  page.on('requestfailed', async (req) => {
    const url = req.url();
    if (!isInteractApi(url)) return;
    try {
      await saveRequestPair(req, null);
    } catch {
      // ignore
    }
  });

  log('capture-interact', `打开页面: ${TARGET_URL}`);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  log('capture-interact', '');
  log('capture-interact', '========================================================');
  log('capture-interact', '浏览器已打开，开始抓包');
  log('capture-interact', '请在浏览器中按以下场景操作（终端会实时输出捕获的 API）：');
  log('capture-interact', '');
  log('capture-interact', '  场景 1 - 通知回复 @：');
  log('capture-interact', '    用小号在某视频评论区 @ 你（小号操作不在本浏览器）');
  log('capture-interact', '    在本浏览器点击通知图标 → 找到 @ 你的通知 → 点击进入');
  log('capture-interact', '    在评论区回复小号的 @（触发 comment/reply 或 comment/publish）');
  log('capture-interact', '');
  log('capture-interact', '  场景 2 - 发布评论：');
  log('capture-interact', '    随便播放一个视频');
  log('capture-interact', '    滚动到评论区，输入评论内容并发送（触发 comment/publish）');
  log('capture-interact', '');
  log('capture-interact', '  场景 3 - 转发分享：');
  log('capture-interact', '    随便播放一个视频');
  log('capture-interact', '    点击分享按钮 → 选择私信 → 选择好友 → 发送');
  log('capture-interact', '    或点击分享按钮 → 复制链接');
  log('capture-interact', '');
  log('capture-interact', '  场景 4 - @好友：');
  log('capture-interact', '    随便播放一个视频');
  log('capture-interact', '    点击分享 → 私信 → 在输入框 @ 好友');
  log('capture-interact', '    或在评论区 @ 好友');
  log('capture-interact', '');
  log('capture-interact', '操作完毕后：');
  log('capture-interact', '  - 关闭浏览器窗口 或 按 Ctrl+C 结束抓包');
  log('capture-interact', '========================================================');
  log('capture-interact', '');

  // 等待浏览器断开或 Ctrl+C
  const disconnected = new Promise<void>((resolve) => {
    browser.once('disconnected', () => resolve());
  });

  const sigint = new Promise<void>((resolve) => {
    const handler = () => {
      process.off('SIGINT', handler);
      resolve();
    };
    process.on('SIGINT', handler);
  });

  await Promise.race([disconnected, sigint]);
  log('capture-interact', '结束抓包，保存收尾文件...');

  // 保存最终摘要
  await fs.writeFile(SUMMARY_FILE, JSON.stringify(summary, null, 2), 'utf-8');

  log('capture-interact', `共捕获 ${summary.length} 个互动相关请求`);
  log('capture-interact', `摘要文件: ${SUMMARY_FILE}`);
  log('capture-interact', `详细请求: ${REQ_DIR}`);

  // 按分类统计
  const byCategory: Record<string, number> = {};
  for (const s of summary) {
    const cat = (s.category as string) || '(uncategorized)';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  }
  log('capture-interact', '按分类统计：');
  for (const [cat, count] of Object.entries(byCategory)) {
    log('capture-interact', `  ${cat}: ${count} 个`);
  }

  try {
    await browser.close();
  } catch {
    // ignore
  }
}

main().catch((e) => {
  log('error', `主流程异常: ${e}`);
  process.exit(1);
});
