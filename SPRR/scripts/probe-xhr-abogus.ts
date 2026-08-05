/**
 * 简化版 hook：直接拦截 fetch 和 XMLHttpRequest 捕获 a_bogus 注入点
 *
 * 关键策略：
 *  - hook URLSearchParams.toString 看参数如何被改写
 *  - hook URL 看 query string 如何注入 a_bogus
 *  - hook Object.defineProperty 捕获 webmssdk 内部的所有 defineProperty
 */
import { chromium } from 'playwright';
import { resolveStorageState } from '../src/auth/accounts.js';
import { createLogger } from '../src/utils/logger.js';
import { writeFileSync } from 'fs';

const log = createLogger('probe-xhr-abogus');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

async function main() {
  const { path: statePath } = await resolveStorageState(undefined, undefined);
  log.info(`storageState: ${statePath}`);

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

  // 注入超级 hook
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    (window as unknown as { __events: Array<{ type: string; info: unknown; ts: number }> }).__events = [];

    function record(type: string, info: unknown): void {
      const arr = (window as unknown as { __events: Array<{ type: string; info: unknown; ts: number }> }).__events;
      arr.push({ type, info, ts: Date.now() });
    }

    // 1. Hook XMLHttpRequest 完整生命周期
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest & { _recordUrl?: string }, method: string, url: string, ...rest: unknown[]) {
      this._recordUrl = url;
      if (url && (url.includes('aweme') || url.includes('/im/'))) {
        record('XHR.open', { method, url: url.substring(0, 500) });
      }
      return (origOpen as (...a: unknown[]) => unknown).apply(this, [method, url, ...rest] as unknown[]);
    } as typeof XMLHttpRequest.prototype.open;

    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest & { _recordUrl?: string }, body?: Document | XMLHttpRequestBodyInit | null) {
      const url = this._recordUrl || '';
      if (url.includes('aweme') || url.includes('/im/')) {
        record('XHR.send', { url: url.substring(0, 500), body: body ? String(body).substring(0, 200) : '' });
      }
      return (origSend as (...a: unknown[]) => unknown).apply(this, [body] as unknown[]);
    } as typeof XMLHttpRequest.prototype.send;

    // 2. Hook fetch
    const origFetch = window.fetch;
    window.fetch = function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : (input as Request)?.url || '';
      if (url && (url.includes('aweme') || url.includes('/im/'))) {
        record('fetch', { url: url.substring(0, 500), method: init?.method || 'GET', body: init?.body ? String(init.body).substring(0, 200) : '' });
      }
      return (origFetch as (...a: unknown[]) => Promise<Response>).apply(this, [input, init] as unknown[]);
    };

    // 3. Hook Object.defineProperty - 捕获 byted_acrawler 怎么注册
    const origDefineProperty = Object.defineProperty;
    let defineCount = 0;
    Object.defineProperty = function (target: object, prop: PropertyKey, descriptor: PropertyDescriptor): object {
      defineCount++;
      if (defineCount <= 100 && typeof prop === 'string') {
        // 只记录关键属性
        if (prop === 'byted_acrawler' || prop === 'webmssdk' || (target && (target as Record<string, unknown>).constructor?.name === 'Window') || (typeof descriptor.value === 'function' && prop.length < 20)) {
          record('defineProperty', { prop, type: typeof descriptor.value });
        }
      }
      return origDefineProperty.call(this, target, prop, descriptor);
    } as typeof Object.defineProperty;

    // 4. Hook Object.assign 看谁在拷贝 byted_acrawler
    const origAssign = Object.assign;
    Object.assign = function (target: object, ...sources: object[]): object {
      for (const s of sources) {
        if (s && ((s as Record<string, unknown>).frontierSign || (s as Record<string, unknown>).init)) {
          record('Object.assign-with-acrawler', { target: (target as Record<string, unknown>).constructor?.name, sourceKeys: Object.keys(s) });
        }
      }
      return origAssign.call(this, target, ...sources);
    };

    // 5. Hook window.__defineGetter__ (老式 getter 定义，bdms 可能用)
    const win = window as unknown as Record<string, unknown>;
    const origDefineGetter = win.__defineGetter__;
    if (typeof origDefineGetter === 'function') {
      (win as unknown as { __defineGetter__: unknown }).__defineGetter__ = function (prop: string, getter: () => unknown) {
        if (typeof prop === 'string' && (prop.includes('byted') || prop.includes('webms'))) {
          record('defineGetter', { prop });
        }
        return (origDefineGetter as (...a: unknown[]) => unknown).call(this, prop, getter);
      };
    }

    // 6. Hook webmssdk _object_function 调用（bdms 用 _object_function 包装 XHR）
    // 当 window.XHR.__lookupSetter__('open') 被调用时记录
    try {
      const origLookupSetter = (Object.prototype as unknown as { __lookupSetter__?: unknown }).__lookupSetter__;
      if (origLookupSetter) {
        (Object.prototype as unknown as { __lookupSetter__: unknown }).__lookupSetter__ = function (this: unknown, prop: string) {
          if (prop === 'open' || prop === 'send') {
            record('__lookupSetter__', { thisName: (this as { constructor?: { name?: string } })?.constructor?.name, prop });
          }
          return (origLookupSetter as (this: unknown, prop: string) => unknown).call(this, prop);
        };
      }
    } catch (_e) {
      // ignore
    }

    // 7. Hook window 字段访问（在内联代理中检测）
    function hookWindowField(field: string): void {
      try {
        const desc = Object.getOwnPropertyDescriptor(window, field);
        if (!desc || !desc.get) return;
        const origGet = desc.get;
        Object.defineProperty(window, field, {
          get() {
            const v = origGet.call(this);
            record('window', { field, value: typeof v === 'object' ? '[obj]' : v });
            return v;
          },
          configurable: true,
        });
      } catch (_e) {
        // ignore
      }
    }
    hookWindowField('innerWidth');
    hookWindowField('innerHeight');
    hookWindowField('outerWidth');
    hookWindowField('outerHeight');
    hookWindowField('devicePixelRatio');
    hookWindowField('screenX');
    hookWindowField('screenY');

    // 8. Hook Function constructor
    const OrigFunction = Function;
    (window as unknown as { OrigFunction: unknown }).OrigFunction = OrigFunction;
    let funcCount = 0;
    (Function as unknown as { __patched: boolean }).__patched = true;
    const fnProxy = new Proxy(Function, {
      construct(target, args) {
        funcCount++;
        const body = args[args.length - 1] as string;
        if (funcCount <= 30 && body && body.length > 50 && body.length < 2000) {
          // 只记录看起来像算法片段的
          if (body.includes('SM3') || body.includes('hash') || body.includes('BDMS') || body.includes('byted') || body.includes('a_bogus') || body.includes('signature')) {
            record('new Function', { args: args.slice(0, -1), bodyLen: body.length, bodySnippet: body.substring(0, 300) });
          }
        }
        return Reflect.construct(target, args);
      },
      apply(target, thisArg, args) {
        return Reflect.apply(target as (...a: never) => unknown, thisArg, args as never[]);
      },
    });
    (globalThis as unknown as { Function: unknown }).Function = fnProxy;

    console.log('[HOOK] Super hook installed at ' + Date.now());
  });

  const page = await context.newPage();
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('HOOK')) log.info(`[browser] ${text}`);
  });

  log.info('访问抖音主页加载 webmssdk...');
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(5000);

  // 触发真实 API
  log.info('触发 a_bogus 生成 (notice API)...');
  await page.evaluate(async () => {
    try {
      const r = await fetch('/aweme/v1/web/im/notice/?notice_group=960', { method: 'GET', credentials: 'include' });
      console.log('[FETCH] notice status', r.status);
    } catch (e) {
      console.log('[FETCH ERR]', (e as Error).message);
    }
  });
  await page.waitForTimeout(3000);

  // 再触发一个写操作
  log.info('触发 sticker collect API...');
  await page.evaluate(async () => {
    try {
      const r = await fetch('/aweme/v1/web/im/resource/sticker/collect/?aid=1128&app_id=1128&device_platform=webapp', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'x-secsdk-csrf-token': 'DOWNGRADE' },
        body: JSON.stringify({}),
      });
      console.log('[FETCH] collect status', r.status);
    } catch (e) {
      console.log('[FETCH ERR]', (e as Error).message);
    }
  });
  await page.waitForTimeout(3000);

  // 抓取所有事件
  const events = await page.evaluate(() => {
    return (window as unknown as { __events: Array<{ type: string; info: unknown; ts: number }> }).__events || [];
  });

  log.info(`\n=== 共捕获 ${events.length} 个事件 ===`);

  // 按类型分组
  const grouped: Record<string, unknown[]> = {};
  for (const e of events) {
    if (!grouped[e.type]) grouped[e.type] = [];
    (grouped[e.type] as unknown[]).push(e.info);
  }

  for (const type of Object.keys(grouped)) {
    const arr = grouped[type] as unknown[];
    log.info(`\n--- ${type} (${arr.length} 个) ---`);
    for (const info of arr.slice(0, 30)) {
      const s = typeof info === 'string' ? info : JSON.stringify(info).substring(0, 500);
      log.info(`  ${s}`);
    }
  }

  writeFileSync('data/probe-xhr-abogus.json', JSON.stringify(events, null, 2));
  log.info(`\n完整事件已写入 data/probe-xhr-abogus.json`);

  await browser.close();
}

main().catch((e) => {
  log.error('失败', e);
  process.exit(1);
});
