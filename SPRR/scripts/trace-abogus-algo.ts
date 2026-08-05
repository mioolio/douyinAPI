/**
 * 浏览器端追踪 a_bogus 算法执行轨迹
 *
 * 策略：
 *   1. 加载真实页面触发 webmssdk / bdms 初始化
 *   2. 在每个关键函数 (Math.random, Date.now, Object.defineProperty 等) 上插入 hook
 *   3. 拦截 byted_acrawler 上的 frontierSign 调用
 *   4. 在 sign 调用前后记录 navigator/screen/window 的访问情况
 *   5. 输出完整的执行轨迹
 *
 * 用法：npx tsx scripts/trace-abogus-algo.ts
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import { resolveStorageState } from '../src/auth/accounts.js';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('trace-abogus-algo');

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

  // 注入追踪脚本（在所有页面脚本之前）
  await context.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    window.__trace = {
      events: [],
      startTs: 0,
      activeId: 0,
    };

    let nextEventId = 0;
    function recordEvent(type, data) {
      const ts = performance.now() - (window.__trace.startTs || 0);
      window.__trace.events.push({
        id: ++nextEventId,
        ts: ts,
        type: type,
        data: data,
      });
    }

    // === Hook Math.random ===
    const origRandom = Math.random;
    Math.random = function() {
      const v = origRandom.call(this);
      recordEvent('Math.random', { value: v });
      return v;
    };

    // === Hook Date.now ===
    const origDateNow = Date.now;
    Date.now = function() {
      const v = origDateNow.call(this);
      recordEvent('Date.now', { value: v });
      return v;
    };

    // === Hook String.fromCharCode ===
    const origFCC = String.fromCharCode;
    String.fromCharCode = function(...codes) {
      const v = origFCC.apply(this, codes);
      recordEvent('String.fromCharCode', { codes: codes, value: v });
      return v;
    };

    // === Hook atob/btoa ===
    const origAtob = window.atob;
    window.atob = function(s) {
      const v = origAtob.call(this, s);
      if (s && s.length > 30) {
        recordEvent('atob', { input_len: s.length, input_head: s.substring(0, 50), output_len: v.length, output_head: v.substring(0, 30) });
      } else {
        recordEvent('atob', { input: s, output: v });
      }
      return v;
    };

    // === Hook btoa ===
    const origBtoa = window.btoa;
    window.btoa = function(s) {
      const v = origBtoa.call(this, s);
      if (s && s.length > 30) {
        recordEvent('btoa', { input_len: s.length, input_head: s.substring(0, 50), output_len: v.length, output_head: v.substring(0, 50) });
      } else {
        recordEvent('btoa', { input: s, output: v });
      }
      return v;
    };

    // === Hook TextEncoder ===
    const OrigTextEncoder = window.TextEncoder;
    if (OrigTextEncoder) {
      const origEncode = OrigTextEncoder.prototype.encode;
      OrigTextEncoder.prototype.encode = function(input) {
        const v = origEncode.call(this, input);
        if (input && input.length > 20) {
          recordEvent('TextEncoder.encode', { input_len: input.length, input_head: input.substring(0, 50), output_len: v.length });
        } else {
          recordEvent('TextEncoder.encode', { input: input, output_len: v ? v.length : 0 });
        }
        return v;
      };
    }

    // === Hook Uint8Array constructor ===
    const OrigUint8Array = window.Uint8Array;
    if (OrigUint8Array) {
      const origFrom = OrigUint8Array.from;
      OrigUint8Array.from = function(arg, mapFn) {
        const v = origFrom.call(this, arg, mapFn);
        if (arg && typeof arg.length === 'number' && arg.length > 0) {
          const head = [];
          for (let i = 0; i < Math.min(20, v.length); i++) head.push(v[i]);
          recordEvent('Uint8Array.from', { len: arg.length, mapFn: mapFn ? mapFn.toString().substring(0, 80) : null, result_head: head });
        }
        return v;
      };
    }

    // === Hook Array.push (用于追踪 data 累积) ===
    const origArrayPush = Array.prototype.push;
    Array.prototype.push = function(...items) {
      const r = origArrayPush.apply(this, items);
      if (this.length > 0 && this.length < 200) {
        // 只追踪已知与签名相关的大数组
        if (this.length === 25 || this.length === 96 || this.length === 100 || (this.length >= 20 && this.length <= 110 && items[0] && typeof items[0] === 'number')) {
          recordEvent('Array.push', { newLen: this.length, items: items.map(x => typeof x === 'number' ? x : String(x).substring(0, 30)) });
        }
      }
      return r;
    };

    // === Hook navigator access (主要字段) ===
    function hookNavField(name) {
      try {
        const orig = navigator[name];
        Object.defineProperty(navigator, name, {
          get() {
            recordEvent('navigator.' + name, { value: orig });
            return orig;
          },
          configurable: true,
        });
      } catch (e) {}
    }
    ['userAgent', 'platform', 'language', 'languages', 'hardwareConcurrency', 'deviceMemory', 'cookieEnabled', 'webdriver', 'plugins', 'mimeTypes', 'vendor', 'appVersion', 'productSub', 'maxTouchPoints', 'doNotTrack'].forEach(hookNavField);

    // === Hook screen access ===
    function hookScreenField(name) {
      try {
        const orig = screen[name];
        Object.defineProperty(screen, name, {
          get() {
            recordEvent('screen.' + name, { value: orig });
            return orig;
          },
          configurable: true,
        });
      } catch (e) {}
    }
    ['width', 'height', 'availWidth', 'availHeight', 'colorDepth', 'pixelDepth', 'orientation', 'availTop', 'availLeft'].forEach(hookScreenField);

    // === Hook window 字段 ===
    function hookWindowField(name) {
      try {
        const desc = Object.getOwnPropertyDescriptor(window, name);
        if (desc && desc.get) {
          const origGet = desc.get;
          Object.defineProperty(window, name, {
            get() {
              const v = origGet.call(this);
              recordEvent('window.' + name, { value: v });
              return v;
            },
            configurable: true,
          });
        }
      } catch (e) {}
    }
    ['innerWidth', 'innerHeight', 'outerWidth', 'outerHeight', 'devicePixelRatio', 'screenX', 'screenY', 'screenLeft', 'screenTop', 'pageXOffset', 'pageYOffset'].forEach(hookWindowField);

    // === Hook document ===
    function hookDocumentField(name) {
      try {
        const orig = document[name];
        Object.defineProperty(document, name, {
          get() {
            const v = orig;
            const result = typeof v === 'string' ? v.substring(0, 200) : String(v).substring(0, 100);
            recordEvent('document.' + name, { value: result });
            return v;
          },
          configurable: true,
        });
      } catch (e) {}
    }
    ['referrer', 'URL', 'cookie', 'domain', 'title', 'hidden', 'visibilityState'].forEach(hookDocumentField);

    // === Hook XHR open/send ===
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      if (url && url.indexOf && url.indexOf('a_bogus=') !== -1) {
        recordEvent('XHR.open', { method: method, url: url.substring(0, 300) });
      }
      return origOpen.apply(this, arguments);
    };

    console.log('[TRACE] Hooks installed at', Date.now());
  `);

  const page = await context.newPage();
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.indexOf('[TRACE]') === 0) log.info(`[browser] ${text}`);
  });

  log.info('访问抖音主页加载 webmssdk...');
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(8000);

  // 检查 byted_acrawler 加载情况
  let acStatus = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return {
      byted: !!w.byted_acrawler,
      allAcrawler: Object.keys(w).filter((k) => /byted|acrawl|webms|sdk|webmss|jsvmp/i.test(k)).slice(0, 30),
      scripts: Array.from(document.scripts).map(s => s.src).filter(s => s && s.length > 0).slice(0, 30),
    };
  });
  log.info(`主页 byted_acrawler 状态: byted=${acStatus.byted}`);

  // 尝试不同页面触发 webmssdk 加载
  if (!acStatus.byted) {
    log.info('尝试 /user/self 页面...');
    await page.goto('https://www.douyin.com/user/self', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(10000);
    acStatus = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return { byted: !!w.byted_acrawler, scripts: Array.from(document.scripts).map(s => s.src).filter(s => s && s.length > 0).slice(0, 30) };
    });
    log.info(`/user/self byted=${acStatus.byted}, 脚本数=${acStatus.scripts.length}`);

    if (acStatus.scripts.length > 0) {
      log.info('已加载脚本:');
      for (const s of acStatus.scripts) log.info(`  ${s}`);
    }
  }

  if (!acStatus.byted) {
    log.info('尝试 /follow 页面...');
    await page.goto('https://www.douyin.com/follow', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(10000);
    acStatus = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return { byted: !!w.byted_acrawler };
    });
    log.info(`/follow byted=${acStatus.byted}`);
  }

  // 重新开始追踪
  log.info('重置追踪，开始触发 sign...');
  await page.evaluate(() => {
    window.__trace.events = [];
    window.__trace.startTs = performance.now();
  });

  // 列出 byted_acrawler 上的所有方法
  const acMethods = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const ac = w.byted_acrawler as Record<string, unknown> | undefined;
    if (!ac) return null;
    const methods: Array<{ key: string; type: string }> = [];
    for (const k of Object.keys(ac)) {
      const v = ac[k];
      methods.push({ key: k, type: typeof v });
    }
    return methods;
  });
  log.info(`byted_acrawler 方法: ${JSON.stringify(acMethods)}`);

  // 直接触发一个真实 API 让 webmssdk 自动生成 a_bogus
  const signResult = await page.evaluate(async () => {
    try {
      const r = await fetch('/aweme/v1/web/im/notice/?notice_group=960', {
        method: 'GET',
        credentials: 'include',
      });
      const url = r.url;
      return { status: r.status, finalUrl: url.substring(0, 400) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  });
  log.info(`真实 API 调用: ${JSON.stringify(signResult).substring(0, 400)}`);

  await page.waitForTimeout(2000);

  // 抓取追踪数据
  const trace = await page.evaluate(() => window.__trace);

  log.info(`\n=== 共捕获 ${trace.events.length} 个事件 ===`);

  // 按类型分组
  const grouped: Record<string, Array<{ ts: number; data: unknown }>> = {};
  for (const e of trace.events) {
    if (!grouped[e.type]) grouped[e.type] = [];
    grouped[e.type].push({ ts: e.ts, data: e.data });
  }

  // 写入文件供后续分析
  writeFileSync('data/trace-abogus.json', JSON.stringify(trace, null, 2));
  log.info(`追踪数据已保存到 data/trace-abogus.json`);

  // 输出关键事件类型
  for (const type of Object.keys(grouped).sort((a, b) => grouped[b].length - grouped[a].length)) {
    const events = grouped[type];
    log.info(`\n[${type}] ${events.length} 次`);
    for (const e of events.slice(0, 15)) {
      const d = typeof e.data === 'string' ? e.data.substring(0, 80) : JSON.stringify(e.data).substring(0, 200);
      log.info(`  t=${e.ts.toFixed(2)}ms  ${d}`);
    }
    if (events.length > 15) log.info(`  ... 还有 ${events.length - 15} 条 ...`);
  }

  // 特别输出事件时间线（按时间排序的关键事件）
  log.info(`\n=== 关键事件时间线 ===`);
  const keyTypes = new Set(['Math.random', 'Date.now', 'String.fromCharCode', 'atob', 'btoa', 'TextEncoder.encode', 'Uint8Array.from', 'Array.push', 'navigator.userAgent', 'screen.width', 'screen.height', 'window.innerWidth', 'window.outerWidth']);
  for (const e of trace.events) {
    if (keyTypes.has(e.type)) {
      const d = typeof e.data === 'string' ? e.data.substring(0, 60) : JSON.stringify(e.data).substring(0, 200);
      log.info(`  [${e.id}] t=${e.ts.toFixed(2)}ms  ${e.type}: ${d}`);
    }
  }

  await browser.close();
}

main().catch((e) => {
  log.error('失败', e);
  process.exit(1);
});
