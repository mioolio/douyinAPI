/**
 * 直接在浏览器中调用 byted_acrawler 的内部方法，捕获 a_bogus 生成的完整输入
 */
import { chromium } from 'playwright';
import { resolveStorageState } from '../src/auth/accounts.js';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('probe-internal');

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

  const page = await context.newPage();
  page.on('console', (msg) => log.info(`[browser] ${msg.text()}`));

  log.info('访问抖音主页...');
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(10000);

  // 在浏览器中探索 byted_acrawler
  const exploration = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const ac = w.byted_acrawler as Record<string, unknown> | undefined;
    if (!ac) {
      return { error: 'byted_acrawler not found', keys: Object.keys(w).filter((k) => /byted|acrawl|webms|sdk/i.test(k)) };
    }

    // 列出所有方法
    const fns: Array<{ name: string; arity: number; type: string }> = [];
    for (const k of Object.keys(ac)) {
      const v = (ac as Record<string, unknown>)[k];
      if (typeof v === 'function') {
        fns.push({ name: k, arity: (v as { length: number }).length, type: 'function' });
      } else {
        fns.push({ name: k, arity: 0, type: typeof v });
      }
    }

    return { acKeys: fns };
  });

  log.info(`byted_acrawler 成员: ${JSON.stringify(exploration, null, 2).substring(0, 3000)}`);

  // 探索 X-Bogus 和 a_bogus 生成路径
  log.info('\n=== 探查 a_bogus 完整生成路径 ===');
  const deepProbe = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const ac = w.byted_acrawler as Record<string, unknown> | undefined;
    if (!ac) return { error: 'no ac' };

    // 拦截 fetch 和 XHR
    const origFetch = window.fetch;
    (window as unknown as { __capturedRequests: Array<{ url: string; ts: number; init: unknown }> }).__capturedRequests = [];
    window.fetch = function (...args: unknown[]) {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request)?.url || '';
      if (url.includes('a_bogus=') || url.includes('X-Bogus')) {
        (window as unknown as { __capturedRequests: Array<{ url: string; ts: number; init: unknown }> }).__capturedRequests.push({
          url: url.substring(0, 500),
          ts: Date.now(),
          init: args[1] ? JSON.parse(JSON.stringify(args[1], (k, v) => typeof v === 'function' ? '[fn]' : v)) : null,
        });
      }
      return origFetch.apply(this, args as Parameters<typeof origFetch>);
    };

    // 拦截 XMLHttpRequest
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    (window as unknown as { __capturedXhr: Array<{ method: string; url: string; body: string }> }).__capturedXhr = [];
    XMLHttpRequest.prototype.open = function (method: string, url: string) {
      (this as unknown as { __url: string; __method: string }).__url = url;
      (this as unknown as { __url: string; __method: string }).__method = method;
      return origOpen.apply(this, [method, url] as Parameters<typeof origOpen>);
    };
    XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
      const url = (this as unknown as { __url: string }).__url;
      if (url && (url.includes('a_bogus=') || url.includes('X-Bogus'))) {
        (window as unknown as { __capturedXhr: Array<{ method: string; url: string; body: string }> }).__capturedXhr.push({
          method: (this as unknown as { __method: string }).__method,
          url: url.substring(0, 500),
          body: typeof body === 'string' ? body : '[non-string]',
        });
      }
      return origSend.apply(this, [body] as Parameters<typeof origSend>);
    };

    // 触发一个真实 API 请求
    return new Promise((resolve) => {
      // 等待一段时间让请求发生
      setTimeout(() => {
        const reqs = (window as unknown as { __capturedRequests: Array<{ url: string; ts: number; init: unknown }> }).__capturedRequests;
        const xhrs = (window as unknown as { __capturedXhr: Array<{ method: string; url: string; body: string }> }).__capturedXhr;
        resolve({
          fetchCount: reqs.length,
          xhrCount: xhrs.length,
          samples: [
            ...reqs.slice(0, 3).map((r) => ({ kind: 'fetch', ...r })),
            ...xhrs.slice(0, 3).map((x) => ({ kind: 'xhr', ...x })),
          ],
        });
      }, 5000);
    });
  });

  log.info(`捕获结果: ${JSON.stringify(deepProbe, null, 2).substring(0, 5000)}`);

  // 触发聊天页让 API 请求发生
  log.info('导航到 chat 触发 API...');
  await page.goto('https://www.douyin.com/user/self?from_tab_name=main&showTab=post', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(10000);

  const finalCapture = await page.evaluate(() => {
    return {
      reqs: (window as unknown as { __capturedRequests?: Array<{ url: string; ts: number }> }).__capturedRequests || [],
      xhrs: (window as unknown as { __capturedXhr?: Array<{ method: string; url: string; body: string }> }).__capturedXhr || [],
    };
  });

  log.info(`\n最终捕获:`);
  log.info(`  fetch: ${(finalCapture.reqs as unknown[]).length}`);
  log.info(`  xhr: ${(finalCapture.xhrs as unknown[]).length}`);

  // 显示样本
  for (const r of (finalCapture.reqs as Array<{ url: string; ts: number }>).slice(0, 3)) {
    log.info(`\nfetch: ${r.url.substring(0, 400)}`);
  }
  for (const x of (finalCapture.xhrs as Array<{ method: string; url: string; body: string }>).slice(0, 3)) {
    log.info(`\nxhr ${x.method}: ${x.url.substring(0, 400)}`);
    log.info(`  body: ${x.body.substring(0, 200)}`);
  }

  await browser.close();
}

main().catch((e) => {
  log.error('失败', e);
  process.exit(1);
});
