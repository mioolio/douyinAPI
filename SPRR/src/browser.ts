/**
 * 浏览器启动器
 *
 * 复用 ccc/data/storageState.json 中已登录的会话，
 * 启动 headful Chromium 并打开抖音聊天页。
 *
 * 关键点：
 * - storageState 包含 cookie + localStorage，跳过登录
 * - 反检测脚本：隐藏 webdriver、补 plugins/chrome
 * - 等待 IM SDK（VMOK）初始化完成
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import path from 'node:path';
import { createLogger } from './utils/logger.js';
import { PROJECT_ROOT } from './config/paths.js';

const log = createLogger('browser');

/** 默认 storageState 路径（与抓包脚本同源） */
export const DEFAULT_STORAGE_STATE = path.resolve(
  PROJECT_ROOT,
  '..',
  'ccc',
  'data',
  'storageState.json',
);

/** 聊天页 URL */
export const CHAT_URL = 'https://www.douyin.com/chat?isPopup=1';

/** 浏览器 UA */
export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** 反检测 init script + esbuild 辅助函数 polyfill */
const ANTI_DETECT = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
window.chrome = window.chrome || { runtime: {} };
// esbuild --keep-names 注入的 __name 辅助函数（page.evaluate 内需要）
if (typeof window.__name !== 'function') {
  window.__name = function(fn, name) { try { if (fn && !fn.name) Object.defineProperty(fn, 'name', { value: name, configurable: true }); } catch (e) {} return fn; };
}
// 兜底其他可能注入的 esbuild 辅助
if (typeof window.__esm !== 'function') {
  window.__esm = function(fn) { return typeof fn === 'function' ? fn() : fn; };
}
if (typeof window.__commonJS !== 'function') {
  window.__commonJS = function(fn) { return typeof fn === 'function' ? fn() : fn; };
}
if (typeof window.__toESM !== 'function') {
  window.__toESM = function(mod) { return mod; };
}
if (typeof window.__copyProps !== 'function') {
  window.__copyProps = function(to, from) { for (const k in from) { if (!(k in to)) to[k] = from[k]; } return to; };
}
`;

/** 注入 window.__getImInstance() 的脚本（被调用时才查找 VMOK） */
const INJECT_GET_INSTANCE = `
window.__getImInstance = async function() {
  const vmokKey = Object.keys(window).find(k => k.startsWith('__VMOK_@pc-im/im'));
  if (!vmokKey) throw new Error('VMOK not found');
  const vmok = window[vmokKey];
  const loader = await vmok.get('.');
  const mod = await loader();
  const instance = mod.Context && mod.Context.instance;
  if (!instance) throw new Error('SDK instance not ready');
  return instance;
};
`;

export interface LaunchOptions {
  /** storageState 文件路径 */
  storageState?: string;
  /** 是否无头（默认 false，便于观察） */
  headless?: boolean;
  /** 等待 SDK 就绪的最长毫秒数 */
  sdkTimeoutMs?: number;
}

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

/**
 * 启动浏览器并打开聊天页，等待 IM SDK 就绪
 */
export async function launchBrowser(opts: LaunchOptions = {}): Promise<BrowserSession> {
  const {
    storageState = DEFAULT_STORAGE_STATE,
    headless = false,
    sdkTimeoutMs = 60_000,
  } = opts;

  log.info(`启动浏览器 (headless=${headless})`);
  const browser = await chromium.launch({
    headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--window-size=1400,900',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    userAgent: DEFAULT_UA,
    storageState,
  });

  await context.addInitScript(ANTI_DETECT);
  await context.addInitScript(INJECT_GET_INSTANCE);

  const page = await context.newPage();
  // 转发浏览器 console 到 Node logger（便于诊断 SDK 内部错误）
  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') {
      log.warn(`[browser:${type}] ${msg.text()}`);
    } else {
      log.debug(`[browser:${type}] ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => {
    log.error(`[browser:pageerror] ${err.message}`);
  });
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (url.includes('imapi') || url.includes('frontier') || url.includes('im.douyin')) {
      log.warn(`[browser:req-failed] ${url} - ${req.failure()?.errorText}`);
    }
  });
  log.info(`打开聊天页: ${CHAT_URL}`);
  await page.goto(CHAT_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  log.info('等待 IM SDK 就绪…');
  await waitForSdk(page, sdkTimeoutMs);
  log.info('IM SDK 已就绪');

  return {
    browser,
    context,
    page,
    close: async () => {
      try {
        await context.close();
      } catch {}
      try {
        await browser.close();
      } catch {}
    },
  };
}

/**
 * 等待 IM SDK（window.__VMOK_@pc-im/im:...）就绪
 *
 * 判定条件：VMOK 全局存在 且 get('.') 能返回 instance
 */
export async function waitForSdk(page: Page, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown = null;

  while (Date.now() - start < timeoutMs) {
    try {
      const ready = await page.evaluate(async () => {
        const vmokKey = Object.keys(window).find(
          (k) => k.startsWith('__VMOK_@pc-im/im'),
        );
        if (!vmokKey) return { ok: false, reason: 'no-vmok' };
        const vmok = (window as unknown as Record<string, unknown>)[vmokKey] as {
          get?: (name: string) => Promise<() => Promise<unknown>>;
        };
        if (!vmok || typeof vmok.get !== 'function') {
          return { ok: false, reason: 'no-get' };
        }
        try {
          const loader = await vmok.get('.');
          const mod = (await loader()) as {
            Context?: { instance?: unknown };
          };
          const instance = mod?.Context?.instance;
          if (!instance) return { ok: false, reason: 'no-instance' };
          const svc = (instance as { imSdkService?: unknown }).imSdkService;
          if (!svc) return { ok: false, reason: 'no-imSdkService' };
          return { ok: true };
        } catch (e) {
          return { ok: false, reason: 'load-fail', err: String(e) };
        }
      });
      if (ready?.ok) return;
      lastErr = ready?.reason || 'unknown';
    } catch (e) {
      lastErr = e;
    }
    await page.waitForTimeout(1000);
  }

  throw new Error(
    `IM SDK 未就绪 (超时 ${timeoutMs}ms, lastErr=${lastErr ? String(lastErr) : 'n/a'})`,
  );
}
