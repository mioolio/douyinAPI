/**
 * 极简 hook 测试 - 只 hook fetch 看是否能捕获到事件
 */
import { chromium } from 'playwright';
import { resolveStorageState } from '../src/auth/accounts.js';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('probe-simple');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

async function main() {
  const { path: statePath } = await resolveStorageState(undefined, undefined);

  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    storageState: statePath,
    userAgent: DEFAULT_UA,
    viewport: { width: 1400, height: 900 },
    locale: 'zh-CN',
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    (window as unknown as { __hits: number }).__hits = 0;
    (window as unknown as { __urls: string[] }).__urls = [];

    const origFetch = window.fetch;
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : (input as Request)?.url || '';
      (window as unknown as { __hits: number }).__hits++;
      (window as unknown as { __urls: string[] }).__urls.push(url.substring(0, 200));
      console.log('[HOOK-FETCH]', url.substring(0, 200));
      return (origFetch as (...a: unknown[]) => Promise<Response>).apply(this, [input, init] as unknown[]);
    };

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method: string, url: string, ...rest: unknown[]) {
      (window as unknown as { __hits: number }).__hits++;
      (window as unknown as { __urls: string[] }).__urls.push('XHR ' + method + ' ' + url.substring(0, 200));
      console.log('[HOOK-XHR-OPEN]', method, url.substring(0, 200));
      return (origOpen as (...a: unknown[]) => unknown).apply(this, [method, url, ...rest] as unknown[]);
    } as typeof XMLHttpRequest.prototype.open;

    console.log('[HOOK] simple hook installed');
  });

  const page = await context.newPage();
  page.on('console', (msg) => {
    log.info(`[browser] ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    log.error(`[page-error] ${err.message}`);
  });

  log.info('访问抖音主页...');
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(8000);

  // 触发一个 notice API 调用
  log.info('触发 notice API...');
  await page.evaluate(async () => {
    try {
      const r = await fetch('/aweme/v1/web/im/notice/?notice_group=960', { method: 'GET', credentials: 'include' });
      console.log('[RESULT] status', r.status);
    } catch (e) {
      console.log('[ERR]', (e as Error).message);
    }
  });
  await page.waitForTimeout(5000);

  const result = await page.evaluate(() => {
    return {
      hasWindow: typeof window !== 'undefined',
      hasHits: typeof (window as Record<string, unknown>).__hits !== 'undefined',
      hasUrls: typeof (window as Record<string, unknown>).__urls !== 'undefined',
      hits: (window as unknown as { __hits?: number }).__hits,
      urls: (window as unknown as { __urls?: string[] }).__urls,
      keys: Object.keys(window).filter((k) => k.startsWith('__')).slice(0, 20),
    };
  });

  log.info(`\n=== 命中 ${result.hits} 次 ===`);
  log.info(`__hits 存在: ${result.hasHits}, __urls 存在: ${result.hasUrls}`);
  log.info(`__keys: ${result.keys.join(', ')}`);
  for (const u of (result.urls || []).slice(0, 30)) {
    log.info(`  ${u}`);
  }

  await browser.close();
}

main().catch((e) => {
  log.error('失败', e);
  process.exit(1);
});
