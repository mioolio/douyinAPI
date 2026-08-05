/**
 * 通过 Playwright 在浏览器内调用 webmssdk.frontierSign
 * 关键：先在主页加载 SDK，再通过 fetch 触发真实请求拦截 frontierSign
 */
import { chromium } from 'playwright';
import { resolveStorageState } from '../src/auth/accounts.js';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('probe-fs2');

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

  // 提前 hook fetch 和 XMLHttpRequest，在请求参数生成时拦截
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // 监控所有 script 加载和 globals
    const origDescriptor = Object.getOwnPropertyDescriptor(window, 'byted_acrawler');
    let hookInstalled = false;
    const tryHook = () => {
      if (hookInstalled) return;
      const w = window as unknown as Record<string, unknown>;
      const ac = w.byted_acrawler as Record<string, unknown> | undefined;
      if (ac && ac.frontierSign && typeof ac.frontierSign === 'function') {
        hookInstalled = true;
        const orig = ac.frontierSign as (...args: unknown[]) => unknown;
        const hooked = function (this: unknown, ...args: unknown[]) {
          const result = orig.apply(this, args);
          (window as unknown as { __fSig: unknown[] }).__fSig = (window as unknown as { __fSig: unknown[] }).__fSig || [];
          (window as unknown as { __fSig: unknown[] }).__fSig.push({
            ts: Date.now(),
            argsJson: JSON.stringify(args).substring(0, 2000),
            resultJson: typeof result === 'string' ? result : JSON.stringify(result),
          });
          return result;
        };
        (hooked as Record<string, unknown>).__hooked = true;
        ac.frontierSign = hooked;
        // 同样 hook getReferer
        if (ac.getReferer && typeof ac.getReferer === 'function') {
          const origGet = ac.getReferer as (...args: unknown[]) => unknown;
          ac.getReferer = function (this: unknown, ...args: unknown[]) {
            const result = origGet.apply(this, args);
            (window as unknown as { __fRef: unknown[] }).__fRef = (window as unknown as { __fRef: unknown[] }).__fRef || [];
            (window as unknown as { __fRef: unknown[] }).__fRef.push({
              ts: Date.now(),
              args: JSON.stringify(args).substring(0, 200),
              result: result,
            });
            return result;
          };
        }
        console.log('[HOOK-OK] byted_acrawler hooked');
      }
    };
    // 每 100ms 尝试一次
    const t = setInterval(tryHook, 100);
    setTimeout(() => clearInterval(t), 60_000);
  });

  const page = await context.newPage();
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('HOOK-OK') || text.includes('__fSig')) {
      log.info(`[browser] ${text}`);
    }
  });

  log.info('访问抖音主页（等待 webmssdk 加载）...');
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(8000);

  // 验证 SDK 已加载
  const sdkStatus = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return {
      hasBytedAcrawler: !!w.byted_acrawler,
      hasFrontierSign: !!(w.byted_acrawler as Record<string, unknown> | undefined)?.frontierSign,
    };
  });
  log.info(`SDK 状态: ${JSON.stringify(sdkStatus)}`);

  if (!sdkStatus.hasFrontierSign) {
    log.error('frontierSign 未加载，等待更久...');
    await page.waitForTimeout(10000);
  }

  // 在浏览器中执行 fetch 请求，触发 webmssdk
  log.info('\n=== 在浏览器内执行 fetch 触发 frontierSign ===');
  const fetchResult = await page.evaluate(async () => {
    const w = window as unknown as Record<string, unknown>;
    const ac = w.byted_acrawler as Record<string, unknown> | undefined;
    if (!ac?.frontierSign) return { error: 'no frontierSign' };

    // 手动调用 frontierSign 获取签名
    const url = '/aweme/v1/web/aweme/post/';
    const params = {
      device_platform: 'webapp',
      aid: '6383',
      channel: 'channel_pc_web',
      sec_user_id: 'MS4wLjABAAAAt1-tyTCsVHPn9nxlcYnY4olIvO-DxMtS6VNLiNN16mE',
      max_cursor: '0',
      locate_query: 'false',
      count: '18',
      update_version_code: '170400',
      pc_client_type: '1',
      pc_libra_divert: 'Windows',
      version_code: '170400',
      version_name: '17.4.0',
      cookie_enabled: 'true',
      screen_width: '1400',
      screen_height: '900',
      browser_language: 'zh-CN',
      browser_platform: 'Win32',
      browser_name: 'Chrome',
      browser_version: '130.0.0.0',
      browser_online: 'true',
      engine_name: 'Blink',
      engine_version: '130.0.0.0',
      os_name: 'Windows',
      os_version: '10',
      device_memory: '16',
      platform: 'PC',
      downlink: '10',
      effective_type: '4g',
      round_trip_time: '150',
    };

    try {
      // 方式 1: 直接调用 frontierSign
      const fsResult = (ac.frontierSign as (...args: unknown[]) => unknown)({
        url,
        params,
        method: 'GET',
      });
      return {
        ok: true,
        result: typeof fsResult === 'string' ? fsResult : JSON.stringify(fsResult),
        hooked: !!(ac.frontierSign as Record<string, unknown>).__hooked,
        sigCalls: ((w.__fSig as unknown[] | undefined) || []).length,
      };
    } catch (e) {
      return { error: (e as Error).message, stack: (e as Error).stack };
    }
  });
  log.info(`fetch 触发结果: ${JSON.stringify(fetchResult, null, 2)}`);

  // 获取拦截数据
  const data = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return {
      hooked: !!(w.byted_acrawler as Record<string, unknown> | undefined)?.frontierSign &&
        !!(w.byted_acrawler as { frontierSign: { __hooked?: boolean } }).frontierSign.__hooked,
      fSig: w.__fSig,
      fRef: w.__fRef,
    };
  });
  log.info(`\nhooked: ${data.hooked}`);
  log.info(`fSig 数量: ${(data.fSig as unknown[] | undefined)?.length || 0}`);
  if (data.fSig && (data.fSig as unknown[]).length > 0) {
    const calls = data.fSig as Array<{ argsJson: string; resultJson: string; ts: number }>;
    log.info(`\n=== 前 ${Math.min(3, calls.length)} 个 frontierSign 调用 ===`);
    for (let i = 0; i < Math.min(3, calls.length); i++) {
      log.info(`\n[${i + 1}] ts=${calls[i].ts}`);
      log.info(`  args: ${calls[i].argsJson}`);
      log.info(`  result: ${calls[i].resultJson.substring(0, 400)}`);
    }
  }

  await browser.close();
}

main().catch((e) => {
  log.error('失败', e);
  process.exit(1);
});
