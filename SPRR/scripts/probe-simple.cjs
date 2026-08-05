/**
 * 极简 hook 测试 - 使用 .cjs 避免 tsx __name helper 问题
 */
const { chromium } = require('playwright');
const log = {
  info: (...args) => console.log('[INFO]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
};

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

(async () => {
  const statePath = 'D:\\Desktop\\DYCC\\SPRR\\data\\accounts\\default.json';

  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    storageState: statePath,
    userAgent: DEFAULT_UA,
    viewport: { width: 1400, height: 900 },
    locale: 'zh-CN',
  });

  // 注入极简 hook
  await context.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: function() { return undefined; } });

    window.__hits = 0;
    window.__urls = [];

    var origFetch = window.fetch;
    window.fetch = function(input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      window.__hits++;
      window.__urls.push('FETCH ' + url.substring(0, 200));
      console.log('[HOOK-FETCH]', url.substring(0, 200));
      return origFetch.apply(this, arguments);
    };

    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      window.__hits++;
      window.__urls.push('XHR ' + method + ' ' + url.substring(0, 200));
      console.log('[HOOK-XHR-OPEN]', method, url.substring(0, 200));
      return origOpen.apply(this, arguments);
    };

    console.log('[HOOK] simple hook installed at', Date.now());
  `);

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

  log.info('触发 notice API...');
  await page.evaluate(async () => {
    try {
      const r = await fetch('/aweme/v1/web/im/notice/?notice_group=960', { method: 'GET', credentials: 'include' });
      console.log('[RESULT] status', r.status);
    } catch (e) {
      console.log('[ERR]', e.message);
    }
  });
  await page.waitForTimeout(5000);

  const result = await page.evaluate(() => {
    return {
      hits: window.__hits,
      urls: window.__urls,
    };
  });

  log.info(`\n=== 命中 ${result.hits} 次 ===`);
  for (const u of (result.urls || []).slice(0, 30)) {
    log.info(`  ${u}`);
  }

  await browser.close();
})();
