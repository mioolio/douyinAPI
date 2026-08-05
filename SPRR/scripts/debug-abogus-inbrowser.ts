/**
 * 使用 Playwright 浏览器调试 a_bogus 生成过程
 *
 * 策略：
 *  1. 加载抖音主页，等待 bdms.js 加载
 *  2. 通过 hook 拦截 a_bogus 的生成链路
 *  3. 触发真实 API 调用，捕获所有中间变量
 *  4. 输出调试信息
 *
 * Hook 层级：
 *  - XMLHttpRequest.open / send：捕获最终请求 URL（含 a_bogus）
 *  - URL / URLSearchParams：捕获被改写的 URL
 *  - Object.defineProperty：捕获 bdms 对 window 的写入
 *  - 浏览器 DOM：捕获设备信息字段访问
 *  - Function / eval：捕获 bdms 动态执行的函数
 */
import { chromium } from 'playwright';
import { resolveStorageState } from '../src/auth/accounts.js';
import { createLogger } from '../src/utils/logger.js';
import { writeFileSync } from 'fs';

const log = createLogger('debug-abogus-inbrowser');

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
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // 全局记录器
    interface CallRecord {
      type: string;
      path: string;
      value: unknown;
      ts: number;
    }
    (window as unknown as { __trace: CallRecord[] }).__trace = [];
    function trace(type: string, path: string, value: unknown): void {
      const arr = (window as unknown as { __trace: CallRecord[] }).__trace;
      arr.push({ type, path, value, ts: Date.now() });
    }

    // ============ 1. Hook XMLHttpRequest.open ============
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string, ...rest: unknown[]) {
      if (url && (url.includes('aweme/v1') || url.includes('/im/'))) {
        trace('XHR.open', 'args', { method, url: url.substring(0, 500) });
      }
      return (origOpen as (...a: unknown[]) => unknown).apply(this, [method, url, ...rest] as unknown[]);
    } as typeof XMLHttpRequest.prototype.open;

    // ============ 2. Hook XMLHttpRequest.send ============
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      try {
        const url = this._url || '';
        if (url.includes('aweme/v1') || url.includes('/im/')) {
          trace('XHR.send', 'url', url.substring(0, 500));
          trace('XHR.send', 'body', body ? String(body).substring(0, 500) : '');
        }
      } catch (_e) {
        // ignore
      }
      return (origSend as (...a: unknown[]) => unknown).apply(this, [body] as unknown[]);
    } as typeof XMLHttpRequest.prototype.send;

    // ============ 3. Hook fetch ============
    const origFetch = window.fetch;
    window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : (input as Request)?.url || '';
      if (url && (url.includes('aweme/v1') || url.includes('/im/'))) {
        trace('fetch', 'url', url.substring(0, 500));
        trace('fetch', 'method', init?.method || 'GET');
        if (init?.body) trace('fetch', 'body', String(init.body).substring(0, 500));
      }
      return (origFetch as (...a: unknown[]) => Promise<Response>).apply(this, [input, init] as unknown[]);
    };

    // ============ 4. Hook XMLHttpRequest 内部的 URL 修改（bdms 可能通过 __lookupSetter__ 拦截） ============
    // 注意：bdms 可能 hook _object_function（Open/Send 的内部 setter）来注入 a_bogus
    const origSetAttribute = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (name: string, value: string) {
      if (name.toLowerCase().includes('secsdk') || name.toLowerCase().includes('bogus') || name.toLowerCase().includes('bd-ticket')) {
        trace('setHeader', name, value.substring(0, 200));
      }
      return origSetAttribute.apply(this, [name, value] as Parameters<typeof origSetAttribute>);
    };

    // ============ 5. Hook navigator / screen 字段访问 ============
    try {
      const navDesc = Object.getOwnPropertyDescriptor(window, 'navigator');
      if (navDesc && navDesc.get) {
        const origNav = navDesc.get;
        Object.defineProperty(window, 'navigator', {
          get() {
            const nav = origNav.call(this);
            return new Proxy(nav, {
              get(target, prop) {
                if (typeof prop === 'string') {
                  const v = (target as unknown as Record<string, unknown>)[prop];
                  if (['userAgent', 'platform', 'language', 'languages', 'hardwareConcurrency', 'deviceMemory', 'cookieEnabled', 'webdriver', 'plugins', 'mimeTypes', 'vendor', 'appVersion'].includes(prop)) {
                    trace('navigator', prop, typeof v === 'string' ? v.substring(0, 200) : Array.isArray(v) ? `[${(v as unknown[]).length} items]` : v);
                  }
                  return v;
                }
                return Reflect.get(target, prop);
              },
            });
          },
          configurable: true,
        });
      }
    } catch (_e) {
      // ignore
    }

    // ============ 6. Hook screen 字段访问 ============
    try {
      const screenDesc = Object.getOwnPropertyDescriptor(window, 'screen');
      if (screenDesc && screenDesc.get) {
        const origScreen = screenDesc.get;
        Object.defineProperty(window, 'screen', {
          get() {
            const s = origScreen.call(this);
            return new Proxy(s, {
              get(target, prop) {
                if (typeof prop === 'string') {
                  const v = (target as unknown as Record<string, unknown>)[prop];
                  if (['width', 'height', 'availWidth', 'availHeight', 'colorDepth', 'pixelDepth', 'orientation'].includes(prop)) {
                    trace('screen', prop, v);
                  }
                  return v;
                }
                return Reflect.get(target, prop);
              },
            });
          },
          configurable: true,
        });
      }
    } catch (_e) {
      // ignore
    }

    // ============ 7. Hook window 常用字段访问 ============
    const WINDOW_FIELDS = ['innerWidth', 'innerHeight', 'outerWidth', 'outerHeight', 'devicePixelRatio', 'screenX', 'screenY', 'screenLeft', 'screenTop', 'pageXOffset', 'pageYOffset'];
    for (const key of WINDOW_FIELDS) {
      try {
        const desc = Object.getOwnPropertyDescriptor(window, key);
        if (desc && desc.get) {
          const origGet = desc.get;
          Object.defineProperty(window, key, {
            get() {
              const v = origGet.call(this);
              trace('window', key, v);
              return v;
            },
            configurable: true,
          });
        }
      } catch (_e) {
        // ignore
      }
    }

    // ============ 8. Hook document.location / window.location ============
    try {
      const locDesc = Object.getOwnPropertyDescriptor(window, 'location');
      if (locDesc && locDesc.get) {
        const origLocGet = locDesc.get;
        Object.defineProperty(window, 'location', {
          get() {
            const loc = origLocGet.call(this);
            trace('window', 'location', String(loc).substring(0, 200));
            return loc;
          },
          configurable: true,
        });
      }
    } catch (_e) {
      // ignore
    }

    console.log('[HOOK] All a_bogus debug hooks installed at ' + Date.now());
  });

  const page = await context.newPage();
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('HOOK') || text.includes('ERROR') || text.includes('error')) {
      log.info(`[browser] ${text}`);
    }
  });

  log.info('访问抖音主页...');
  try {
    await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (e) {
    log.warn(`主页访问失败: ${(e as Error).message}`);
  }
  await page.waitForTimeout(8000);

  // 检查 byted_acrawler 是否加载
  const sdkInfo = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const ac = w.byted_acrawler as Record<string, unknown> | undefined;
    return {
      hasAcrawler: !!ac,
      acKeys: ac ? Object.keys(ac).slice(0, 50) : [],
      frontierSignType: ac && ac.frontierSign ? typeof ac.frontierSign : 'none',
    };
  });
  log.info(`SDK 加载状态: ${JSON.stringify(sdkInfo)}`);

  // 触发 a_bogus：通过 fetch 一个真实 API
  log.info('触发真实 API 调用 (history) 触发 a_bogus...');
  await page.evaluate(async () => {
    try {
      // 调用一个真实的 API endpoint 触发 a_bogus 生成
      const url = '/aweme/v1/web/im/notice/?notice_group=960';
      const r = await fetch(url, { method: 'GET', credentials: 'include' });
      log.info?.('fetch result status', r.status);
    } catch (e) {
      console.log('[FETCH ERR]', (e as Error).message);
    }
  });

  // 等待 bdms 注入 a_bogus
  await page.waitForTimeout(5000);

  // 抓取所有 trace 记录
  const trace = await page.evaluate(() => {
    return (window as unknown as { __trace?: Array<{ type: string; path: string; value: unknown; ts: number }> }).__trace || [];
  });
  log.info(`\n=== 共捕获 ${trace.length} 个事件 ===\n`);

  // 按类型分组
  const grouped: Record<string, Array<{ path: string; value: unknown; ts: number }>> = {};
  for (const t of trace) {
    if (!grouped[t.type]) grouped[t.type] = [];
    grouped[t.type].push({ path: t.path, value: t.value, ts: t.ts });
  }

  for (const type of ['navigator', 'screen', 'window', 'document', 'XHR.open', 'XHR.send', 'fetch', 'setHeader']) {
    const arr = grouped[type] || [];
    log.info(`\n--- ${type} (${arr.length} 个) ---`);
    for (const e of arr.slice(0, 50)) {
      const v = typeof e.value === 'string' ? e.value.substring(0, 200) : JSON.stringify(e.value).substring(0, 200);
      log.info(`  ${e.path} = ${v}`);
    }
  }

  // 写入文件
  writeFileSync('data/debug-abogus-inbrowser.json', JSON.stringify(trace, null, 2));
  log.info(`\n完整 trace 已写入 data/debug-abogus-inbrowser.json`);

  await browser.close();
}

main().catch((e) => {
  log.error('失败', e);
  process.exit(1);
});
