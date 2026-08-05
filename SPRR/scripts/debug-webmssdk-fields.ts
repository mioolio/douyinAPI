/**
 * 调试 webmssdk：hook 所有 DOM 访问，捕获 a_bogus 实际使用的设备字段
 *
 * 增强版：
 *   1. 拦截所有 navigator / screen / window 访问
 *   2. 拦截所有 fetch / XHR 请求，捕获 URL 中的 a_bogus / x-secsdk
 *   3. 通过 console 实时输出捕获到的字段
 *   4. 触发真实 API 调用验证 webmssdk 是否被 hook
 *
 * 用法：npx tsx scripts/debug-webmssdk-fields.ts
 */
import { chromium } from 'playwright';
import { resolveStorageState } from '../src/auth/accounts.js';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('debug-webmssdk-fields');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

async function main() {
  const { path: statePath } = await resolveStorageState(undefined, undefined);
  log.info(`使用 storageState: ${statePath}`);

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  const context = await browser.newContext({
    storageState: statePath,
    userAgent: DEFAULT_UA,
    viewport: { width: 1400, height: 900 },
    locale: 'zh-CN',
  });

  // 在所有脚本执行前注入 hook
  await context.addInitScript(() => {
    // 改 webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // 初始化全局记录器
    (window as unknown as { __hookLog: Array<{ path: string; value: unknown; ts: number }> }).__hookLog = [];
    (window as unknown as { __fetchLog: Array<{ url: string; method: string; ts: number }> }).__fetchLog = [];

    function record(path: string, value: unknown): void {
      const log = (window as unknown as { __hookLog: Array<{ path: string; value: unknown; ts: number }> }).__hookLog;
      // 不去重，记录所有访问
      log.push({ path, value: typeof value === 'function' ? '[function]' : value, ts: Date.now() });
    }

    // hook window.navigator
    const origNavDescriptor = Object.getOwnPropertyDescriptor(window, 'navigator') ||
      Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    if (origNavDescriptor && origNavDescriptor.get) {
      const origNavGet = origNavDescriptor.get;
      Object.defineProperty(window, 'navigator', {
        get() {
          const nav = origNavGet.call(this);
          record('navigator.__accessed__', '[proxy]');
          return new Proxy(nav, {
            get(target, prop) {
              if (typeof prop === 'string') {
                const v = (target as unknown as Record<string, unknown>)[prop];
                record(`navigator.${prop}`, v);
                return v;
              }
              return Reflect.get(target, prop);
            },
            has(target, prop) {
              if (typeof prop === 'string') record(`navigator.has(${prop})`, true);
              return Reflect.has(target, prop);
            },
          });
        },
        configurable: true,
      });
    } else {
      console.log('[HOOK] navigator descriptor not found');
    }

    // hook window.screen
    const origScreenDescriptor = Object.getOwnPropertyDescriptor(window, 'screen');
    if (origScreenDescriptor && origScreenDescriptor.get) {
      const origScreenGet = origScreenDescriptor.get;
      Object.defineProperty(window, 'screen', {
        get() {
          const s = origScreenGet.call(this);
          record('screen.__accessed__', '[proxy]');
          return new Proxy(s, {
            get(target, prop) {
              if (typeof prop === 'string') {
                const v = (target as unknown as Record<string, unknown>)[prop];
                record(`screen.${prop}`, v);
                return v;
              }
              return Reflect.get(target, prop);
            },
          });
        },
        configurable: true,
      });
    }

    // hook window 常用属性
    for (const key of ['innerWidth', 'innerHeight', 'outerWidth', 'outerHeight', 'devicePixelRatio', 'screenX', 'screenY', 'pageXOffset', 'pageYOffset', 'screenLeft', 'screenTop', 'clientWidth', 'clientHeight']) {
      try {
        const orig = (window as unknown as Record<string, unknown>)[key];
        Object.defineProperty(window, key, {
          get() {
            record(`window.${key}`, orig);
            return orig;
          },
          configurable: true,
        });
      } catch {
        // ignore
      }
    }

    // hook document
    const origDocDescriptor = Object.getOwnPropertyDescriptor(window, 'document');
    if (origDocDescriptor && origDocDescriptor.get) {
      const origDocGet = origDocDescriptor.get;
      Object.defineProperty(window, 'document', {
        get() {
          const doc = origDocGet.call(this);
          record('document.__accessed__', '[proxy]');
          return new Proxy(doc, {
            get(target, prop) {
              if (typeof prop === 'string') {
                // 只记录核心属性访问
                if (['referrer', 'URL', 'cookie', 'domain', 'title', 'hidden', 'visibilityState'].includes(prop)) {
                  const v = (target as unknown as Record<string, unknown>)[prop];
                  record(`document.${prop}`, typeof v === 'string' ? v.substring(0, 200) : v);
                  return v;
                }
              }
              return Reflect.get(target, prop);
            },
          });
        },
        configurable: true,
      });
    }

    // hook fetch
    const origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function (...args: unknown[]) {
        const input = args[0];
        const url = typeof input === 'string' ? input : (input as Request)?.url || '';
        const method = ((args[1] as RequestInit | undefined)?.method as string) || 'GET';
        if (url.includes('a_bogus') || url.includes('x-secsdk') || url.includes('aweme/v1')) {
          const fl = (window as unknown as { __fetchLog: Array<{ url: string; method: string; ts: number }> }).__fetchLog;
          fl.push({ url: url.substring(0, 300), method, ts: Date.now() });
        }
        return (origFetch as (...a: unknown[]) => Promise<Response>).apply(this, args as Parameters<typeof origFetch>);
      };
    }

    // hook XMLHttpRequest
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method: string, url: string) {
      if (url.includes('a_bogus') || url.includes('x-secsdk') || url.includes('aweme/v1')) {
        const fl = (window as unknown as { __fetchLog: Array<{ url: string; method: string; ts: number }> }).__fetchLog;
        fl.push({ url: url.substring(0, 300), method, ts: Date.now() });
      }
      return origOpen.apply(this, [method, url] as Parameters<typeof origOpen>);
    };

    console.log('[HOOK] DOM access hook installed at ' + Date.now());
  });

  const page = await context.newPage();
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('HOOK') || text.includes('DEBUG') || text.includes('error')) {
      log.info(`[browser] ${text}`);
    }
  });

  // 拦截所有 a_bogus 请求，验证 webmssdk 正常工作
  const capturedRequests: Array<{ url: string; aBogus?: string; secsdk?: string; ts?: string }> = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('a_bogus=')) {
      const u = new URL(url);
      capturedRequests.push({
        url: u.pathname,
        aBogus: u.searchParams.get('a_bogus') || undefined,
        secsdk: u.searchParams.get('x-secsdk-web-signature') || undefined,
        ts: u.searchParams.get('timestamp') || undefined,
      });
    }
  });

  log.info('访问抖音主页...');
  try {
    await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (e) {
    log.warn(`主页访问失败: ${(e as Error).message}`);
  }
  await page.waitForTimeout(8000);

  // 触发 a_bogus：直接调用 webmssdk.frontierSign
  log.info('手动调用 frontierSign 触发 a_bogus 生成...');
  const signResult = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const ac = w.byted_acrawler as Record<string, unknown> | undefined;
    if (!ac) return { error: 'byted_acrawler not found', keys: Object.keys(w).filter((k) => /byted|acrawl|webms|sdk/i.test(k)).slice(0, 20) };
    const fs = ac.frontierSign as (...a: unknown[]) => unknown;
    if (!fs) return { error: 'frontierSign not found', acKeys: Object.keys(ac) };
    try {
      const r = fs({
        url: '/aweme/v1/web/aweme/post/',
        params: {
          device_platform: 'webapp',
          aid: '6383',
          channel: 'channel_pc_web',
          sec_user_id: 'MS4wLjABAAAA',
          max_cursor: '0',
          count: '18',
        },
        method: 'GET',
      });
      return { result: typeof r === 'string' ? r : JSON.stringify(r) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  });
  log.info(`frontierSign 调用结果: ${JSON.stringify(signResult).substring(0, 300)}`);

  // 再触发一些 chat API
  await page.waitForTimeout(3000);
  log.info('导航到 IM 聊天 API 触发...');
  await page.goto('https://www.douyin.com/follow', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(8000);

  // 抓取所有 DOM 访问记录
  const hookLog = await page.evaluate(() => {
    return (window as unknown as { __hookLog: Array<{ path: string; value: unknown; ts: number }> }).__hookLog || [];
  });
  const fetchLog = await page.evaluate(() => {
    return (window as unknown as { __fetchLog: Array<{ url: string; method: string; ts: number }> }).__fetchLog || [];
  });

  log.info(`\n=== 共捕获 ${hookLog.length} 个 DOM 访问 ===`);
  log.info(`=== 共捕获 ${fetchLog.length} 个 fetch/XHR 事件 ===`);
  log.info(`=== capturedRequests (含 a_bogus): ${capturedRequests.length} ===`);

  if (capturedRequests.length > 0) {
    log.info(`\n--- 包含 a_bogus 的请求 ---`);
    for (const r of capturedRequests.slice(0, 5)) {
      log.info(`  ${r.url}`);
      log.info(`    a_bogus (len=${r.aBogus?.length}): ${r.aBogus?.substring(0, 100)}...`);
      log.info(`    secsdk: ${r.secsdk?.substring(0, 60)}...`);
      log.info(`    ts: ${r.ts}`);
    }
  }

  // 按类别分组 + 去重
  const seen = new Set<string>();
  const grouped: Record<string, Array<{ path: string; value: unknown }>> = {
    navigator: [],
    screen: [],
    window: [],
    document: [],
  };
  for (const e of hookLog) {
    let cat = 'other';
    if (e.path.startsWith('navigator')) cat = 'navigator';
    else if (e.path.startsWith('screen')) cat = 'screen';
    else if (e.path.startsWith('window')) cat = 'window';
    else if (e.path.startsWith('document')) cat = 'document';
    if (!seen.has(e.path)) {
      seen.add(e.path);
      (grouped[cat] || (grouped[cat] = [])).push({ path: e.path, value: e.value });
    }
  }

  for (const cat of ['navigator', 'screen', 'window', 'document']) {
    log.info(`\n--- ${cat} (${(grouped[cat] || []).length}) ---`);
    for (const e of (grouped[cat] || []).slice(0, 100)) {
      const v = typeof e.value === 'string' ? e.value.substring(0, 80) : JSON.stringify(e.value).substring(0, 80);
      log.info(`  ${e.path} = ${v}`);
    }
  }

  log.info(`\n--- fetch/XHR (${fetchLog.length}) ---`);
  for (const f of fetchLog.slice(0, 20)) {
    log.info(`  ${f.method} ${f.url.substring(0, 200)}`);
  }

  await browser.close();
}

main().catch((e) => {
  log.error('失败', e);
  process.exit(1);
});
