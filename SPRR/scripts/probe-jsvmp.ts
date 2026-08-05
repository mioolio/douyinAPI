/**
 * 探索 webmssdk JSVMP 字节码函数，找到生成 a_bogus 的入口
 *
 * 关键发现：
 *   - frontierSign 只返回 X-Bogus
 *   - a_bogus 由 JSVMP 字节码函数 _$webrt_xxx 生成
 *   - XHR.send 被 hook 触发字节码执行
 *
 * 策略：
 *   1. 列出 window 上所有 _$webrt_xxx 格式的 JSVMP 函数
 *   2. Hook XHR.send 触发字节码执行，捕获调用栈
 *   3. 找到生成 a_bogus 的具体字节码函数
 */
import { chromium } from 'playwright';
import { resolveStorageState } from '../src/auth/accounts.js';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('probe-jsvmp');

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

  // 在脚本执行前注入 hook
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    const w = window as unknown as Record<string, unknown>;
    (w.__jsvmpFns as string[]) = [];
    (w.__jsvmpCallLog as unknown[]) = [];

    // 1. 扫描 window 上 _$webrt_xxx 格式的函数
    function scanJSVMP(): void {
      const fns: string[] = [];
      for (const k of Object.keys(w)) {
        if (/_?\$webrt_/.test(k) || /^_webms_/.test(k) || /_webms_/.test(k)) {
          const v = w[k];
          if (typeof v === 'function') fns.push(k);
        }
      }
      (w.__jsvmpFns as string[]).length = 0;
      (w.__jsvmpFns as string[]).push(...fns);
    }

    // 2. 监视 window 属性的变化
    const origDefineProperty = Object.defineProperty;
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      scanJSVMP();
      if (attempts > 100) clearInterval(interval);
    }, 200);

    // 3. Hook XHR.send 调用栈
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body: Document | XMLHttpRequestBodyInit | null | undefined) {
      const stack = new Error().stack || '';
      if (stack.includes('aweme') || this._url?.toString().includes('aweme')) {
        (w.__jsvmpCallLog as unknown[]).push({ phase: 'send', stack: stack.substring(0, 1500), ts: Date.now() });
        console.log('[XHR_SEND] ' + stack.substring(0, 800));
      }
      return origSend.apply(this, [body] as Parameters<typeof origSend>);
    };

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method: string, url: string) {
      if (typeof url === 'string' && url.includes('aweme')) {
        const stack = new Error().stack || '';
        (w.__jsvmpCallLog as unknown[]).push({ phase: 'open', stack: stack.substring(0, 1500), ts: Date.now() });
        console.log('[XHR_OPEN] ' + stack.substring(0, 800));
      }
      return origOpen.apply(this, [method, url] as Parameters<typeof origOpen>);
    };
  });

  const page = await context.newPage();
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('[XHR_') || text.startsWith('[JSVMP]')) {
      log.info(`[browser] ${text}`);
    }
  });

  log.info('访问抖音主页加载 webmssdk...');
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(8000);

  // 1. 列出所有 JSVMP 函数
  const jsvmpFnsResult = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const fns = (w.__jsvmpFns as string[]) || [];
    return Array.from(fns);
  });
  log.info(`\n=== 找到 ${jsvmpFnsResult.length} 个 JSVMP 函数 ===`);
  for (const k of jsvmpFnsResult) {
    log.info(`  ${k}`);
  }

  // 2. 详细查看每个 JSVMP 函数
  const fnDetails = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const fns = (w.__jsvmpFns as string[]) || [];
    return fns.map((k) => {
      const fn = w[k] as (...a: unknown[]) => unknown;
      if (typeof fn !== 'function') return { key: k, type: typeof fn };
      return {
        key: k,
        length: fn.length,
        toString: fn.toString().substring(0, 250),
      };
    });
  });
  for (const f of fnDetails) {
    log.info(`  ${f.key} (len=${(f as { length?: number }).length}): ${(f as { toString?: string }).toString?.substring(0, 200)}`);
  }

  // 3. 尝试手动调用每个 JSVMP 函数
  const testInput = 'test_input_' + Date.now();
  const calls = await page.evaluate((input) => {
    const w = window as unknown as Record<string, unknown>;
    const results: Array<{ key: string; ok: boolean; result: string; type: string; err?: string }> = [];
    for (const k of Object.keys(w)) {
      if (!/_?\$webrt_/.test(k) && !/^_webms_/.test(k) && !/_webms_/.test(k)) continue;
      const fn = w[k];
      if (typeof fn !== 'function') continue;
      try {
        const r = (fn as (...a: unknown[]) => unknown).call(w, input);
        const t = typeof r;
        let v = '';
        if (typeof r === 'string') v = r;
        else if (r && typeof r === 'object') {
          try { v = JSON.stringify(r).substring(0, 200); } catch { v = '[obj]'; }
        } else v = String(r);
        results.push({ key: k, ok: true, result: v, type: t });
      } catch (e) {
        results.push({ key: k, ok: false, result: '', type: 'error', err: (e as Error).message.substring(0, 100) });
      }
    }
    return results;
  }, testInput);

  log.info(`\n=== 调用 ${calls.length} 个 JSVMP 函数 ===`);
  for (const c of calls) {
    if (c.ok && c.result) {
      log.info(`  ${c.key}: type=${c.type}, len=${c.result.length}, val=${c.result.substring(0, 150)}`);
    } else if (!c.ok) {
      log.info(`  ${c.key}: ERROR ${c.err}`);
    }
  }

  // 4. 触发真实业务，看 XHR 调用栈
  log.info('\n=== 触发真实业务 (follow 页面) ===');
  await page.goto('https://www.douyin.com/follow', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(8000);

  const logEntries = await page.evaluate(() => {
    const arr = (window as unknown as { __jsvmpCallLog: unknown[] }).__jsvmpCallLog;
    return Array.from(arr || []);
  });
  log.info(`XHR 调用日志数: ${logEntries.length}`);
  for (let i = 0; i < Math.min(3, logEntries.length); i++) {
    const e = logEntries[i] as { phase: string; stack: string };
    log.info(`\n--- ${e.phase} 调用栈 ${i + 1} ---`);
    log.info(e.stack.substring(0, 1500));
  }

  await browser.close();
}

main().catch((e) => {
  log.error('失败', e);
  process.exit(1);
});
