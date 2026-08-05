/**
 * 通过 Playwright 在浏览器内调用 webmssdk.frontierSign
 * 使用 addInitScript 提前 hook，触发真实 API 调用拦截签名输入输出
 */
import { chromium } from 'playwright';
import { resolveStorageState } from '../src/auth/accounts.js';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('probe-frontier-sign');

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

  // 提前 hook byted_acrawler
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // 监听 byted_acrawler 出现
    let checkCount = 0;
    const interval = setInterval(() => {
      checkCount++;
      const w = window as unknown as Record<string, unknown>;
      const ac = w.byted_acrawler as Record<string, unknown> | undefined;
      if (ac && ac.frontierSign && !(ac.frontierSign as { __hooked?: boolean }).__hooked) {
        clearInterval(interval);
        const origFrontierSign = ac.frontierSign as (...args: unknown[]) => unknown;
        const hooked = function (this: unknown, ...args: unknown[]) {
          (window as unknown as { __frontierSignCalls: unknown[] }).__frontierSignCalls = (window as unknown as { __frontierSignCalls: unknown[] }).__frontierSignCalls || [];
          (window as unknown as { __frontierSignCalls: unknown[] }).__frontierSignCalls.push({
            args: JSON.parse(JSON.stringify(args)),
            stack: new Error().stack?.split('\n').slice(0, 5).join(' | '),
            ts: Date.now(),
          });
          const result = origFrontierSign.apply(this, args);
          (window as unknown as { __frontierSignCalls: unknown[] }).__frontierSignCalls[(
            (window as unknown as { __frontierSignCalls: unknown[] }).__frontierSignCalls.length - 1
          )] = Object.assign(
            (window as unknown as { __frontierSignCalls: unknown[] }).__frontierSignCalls[
              (window as unknown as { __frontierSignCalls: unknown[] }).__frontierSignCalls.length - 1
            ],
            { result: typeof result === 'string' ? result.substring(0, 300) : JSON.stringify(result).substring(0, 300) },
          );
          return result;
        };
        (hooked as { __hooked?: boolean }).__hooked = true;
        ac.frontierSign = hooked;
        // hook getReferer
        if (ac.getReferer && typeof ac.getReferer === 'function') {
          const origGetReferer = ac.getReferer as (...args: unknown[]) => unknown;
          ac.getReferer = function (this: unknown, ...args: unknown[]) {
            (window as unknown as { __getRefererCalls: unknown[] }).__getRefererCalls = (window as unknown as { __getRefererCalls: unknown[] }).__getRefererCalls || [];
            (window as unknown as { __getRefererCalls: unknown[] }).__getRefererCalls.push({
              args: JSON.parse(JSON.stringify(args)),
              ts: Date.now(),
            });
            return origGetReferer.apply(this, args);
          };
        }
        (window as unknown as { __hooked: boolean }).__hooked = true;
        console.log('[HOOK] byted_acrawler.frontierSign hooked at ' + Date.now());
      }
      if (checkCount > 500) {
        clearInterval(interval);
        console.log('[HOOK-FAIL] byted_acrawler not found after 50s');
      }
    }, 100);
  });

  // 调试：每个页面加载完成后都打印 byted_acrawler 状态
  context.on('page', (p) => {
    p.on('console', (msg) => {
      console.log(`[${p.url().substring(0, 50)}] ${msg.text()}`);
    });
  });

  const page = await context.newPage();
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('HOOK') || text.includes('FRONTIER')) {
      log.info(`[browser] ${text}`);
    }
  });

  log.info('访问抖音主页...');
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(8000);

  // 触发一些真实页面交互，触发 a_bogus 请求
  log.info('导航到聊天页触发 API 请求...');
  await page.goto('https://www.douyin.com/aweme/v1/web/aweme/post/?device_platform=webapp&aid=6383', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  }).catch((e: unknown) => log.warn(`导航失败: ${(e as Error).message}`));
  await page.waitForTimeout(10000);

  // 手动触发 fetch 请求
  log.info('在浏览器内手动调用 frontierSign...');
  const manualResult = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const ac = w.byted_acrawler as Record<string, unknown> | undefined;
    if (!ac || !ac.frontierSign) {
      return { error: 'byted_acrawler.frontierSign 不可用', keys: Object.keys(w).filter((k) => /byted|acrawl|webms/i.test(k)) };
    }
    try {
      // 尝试调用 frontierSign，参数为对象
      const result = (ac.frontierSign as (...args: unknown[]) => unknown)({
        url: '/aweme/v1/web/aweme/post/',
        params: {
          device_platform: 'webapp',
          aid: '6383',
          channel: 'channel_pc_web',
          sec_user_id: 'MS4wLjABAAAAt1-tyTCsVHPn9nxlcYnY4olIvO-DxMtS6VNLiNN16mE',
          max_cursor: '0',
          count: '18',
        },
        method: 'GET',
      });
      return { result: typeof result === 'string' ? result : JSON.stringify(result) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  });
  log.info(`手动调用结果: ${JSON.stringify(manualResult, null, 2)}`);

  await page.waitForTimeout(3000);

  // 获取拦截数据
  const data = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return {
      hooked: w.__hooked,
      frontierSignCalls: w.__frontierSignCalls,
      getRefererCalls: w.__getRefererCalls,
    };
  });

  log.info(`\n=== 拦截结果 ===`);
  log.info(`hooked: ${data.hooked}`);
  log.info(`frontierSign 调用次数: ${(data.frontierSignCalls as unknown[] | undefined)?.length || 0}`);
  log.info(`getReferer 调用次数: ${(data.getRefererCalls as unknown[] | undefined)?.length || 0}`);

  if (data.frontierSignCalls && (data.frontierSignCalls as unknown[]).length > 0) {
    log.info(`\n=== frontierSign 调用详情 ===`);
    const calls = data.frontierSignCalls as Array<{ args: unknown; result: string; stack: string; ts: number }>;
    for (let i = 0; i < Math.min(calls.length, 3); i++) {
      log.info(`\n[调用 ${i + 1}] ts=${calls[i].ts}`);
      log.info(`  args[0] type: ${typeof calls[i].args[0]}`);
      log.info(`  args[0] keys: ${calls[i].args[0] && typeof calls[i].args[0] === 'object' ? Object.keys(calls[i].args[0] as object).join(', ') : 'N/A'}`);
      log.info(`  args[0]: ${JSON.stringify(calls[i].args[0]).substring(0, 800)}`);
      log.info(`  args[1]: ${JSON.stringify(calls[i].args[1]).substring(0, 400)}`);
      log.info(`  result (前 200): ${calls[i].result}`);
      log.info(`  stack: ${calls[i].stack}`);
    }
  }

  await browser.close();
}

main().catch((e) => {
  log.error('失败', e);
  process.exit(1);
});
