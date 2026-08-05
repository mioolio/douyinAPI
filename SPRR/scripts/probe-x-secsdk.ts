/**
 * x-secsdk-web-signature 抓取脚本
 *
 * 流程：
 *   1. 启动浏览器，加载已登录 storageState
 *   2. 访问抖音主页
 *   3. 通过 page.on('request') 捕获带 x-secsdk-web-signature 的请求
 *   4. 抓 timestamp + x-secsdk-web-signature + path + params + msToken
 *   5. 输出供分析（可能需要多次捕获对比同一 path 不同时间戳）
 *
 * 用法：npx tsx scripts/probe-x-secsdk.ts
 */
import { chromium } from 'playwright';
import { resolveStorageState } from '../src/auth/accounts.js';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('probe-x-secsdk');

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
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();

  // 收集所有带 secsdk 的请求
  const captures: Array<{
    url: string;
    method: string;
    timestamp: string;
    secsdk: string;
    aBogus: string;
  }> = [];

  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('x-secsdk-web-signature')) return;
    const u = new URL(url);
    const timestamp = u.searchParams.get('timestamp') || '';
    const secsdk = u.searchParams.get('x-secsdk-web-signature') || '';
    const aBogus = u.searchParams.get('a_bogus') || '';
    captures.push({
      url: u.pathname,
      method: req.method(),
      timestamp,
      secsdk,
      aBogus,
    });
    log.info(`\n[捕获] ${req.method()} ${u.pathname}`);
    log.info(`  timestamp: ${timestamp}`);
    log.info(`  x-secsdk-web-signature: ${secsdk}`);
  });

  log.info('访问抖音主页...');
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(8000);

  // 触发一些请求
  await page.goto('https://www.douyin.com/user/self', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  }).catch(() => undefined);
  await page.waitForTimeout(5000);

  await browser.close();

  log.info(`\n\n=== 共捕获 ${captures.length} 个带 secsdk 的请求 ===`);

  // 重点分析：相同 path 不同 timestamp 的 x-secsdk-web-signature
  // 算法通常是 secsdk = md5(timestamp + path + "盐值") 或类似
  const byPath: Record<string, Array<{ timestamp: string; secsdk: string }>> = {};
  for (const c of captures) {
    if (!byPath[c.url]) byPath[c.url] = [];
    byPath[c.url].push({ timestamp: c.timestamp, secsdk: c.secsdk });
  }

  for (const [path, list] of Object.entries(byPath).slice(0, 5)) {
    log.info(`\n--- ${path} (${list.length} 次) ---`);
    for (const item of list) {
      log.info(`  ts=${item.timestamp}  secsdk=${item.secsdk}`);
    }
  }

  // 反推：x-secsdk-web-signature 32 位 → MD5
  // 测试 MD5(timestamp + path)
  const crypto = await import('node:crypto');
  log.info(`\n=== 假设 secsdk = MD5(timestamp + path) ===`);
  for (const [path, list] of Object.entries(byPath).slice(0, 3)) {
    for (const item of list.slice(0, 2)) {
      const guess1 = crypto
        .createHash('md5')
        .update(item.timestamp + path)
        .digest('hex');
      const guess2 = crypto
        .createHash('md5')
        .update(path + item.timestamp)
        .digest('hex');
      log.info(
        `  ts=${item.timestamp}  path=${path}  实际=${item.secsdk}  guess(ts+path)=${guess1}  guess(path+ts)=${guess2}`,
      );
    }
  }
}

main().catch((e) => {
  log.error('失败', e);
  process.exit(1);
});
