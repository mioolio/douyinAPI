/**
 * 直接捕获 webmssdk 内部调用：frontierSign 和 byted_acrawler._getSign
 * 获取输入参数对象的所有字段，验证我们当前的实现与浏览器差异
 */
import { chromium } from 'playwright';
import { resolveStorageState } from '../src/auth/accounts.js';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('probe-frontier-deep');

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

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    (window as unknown as { __allCalls: unknown[] }).__allCalls = [];
    (window as unknown as { __hooked: boolean }).__hooked = false;

    function deepClone(obj: unknown, depth = 0): unknown {
      if (depth > 5) return '[max depth]';
      if (obj == null) return obj;
      if (typeof obj !== 'object') return obj;
      if (Array.isArray(obj)) return obj.map((v) => deepClone(v, depth + 1));
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(obj as object)) {
        const v = (obj as Record<string, unknown>)[k];
        if (typeof v === 'function') out[k] = '[function]';
        else if (typeof v === 'string' && v.length > 200) out[k] = v.substring(0, 200) + '...';
        else if (typeof v === 'object' && v !== null) out[k] = deepClone(v, depth + 1);
        else out[k] = v;
      }
      return out;
    }

    function tryHook(): boolean {
      const w = window as unknown as Record<string, unknown>;
      const ac = w.byted_acrawler as Record<string, unknown> | undefined;
      if (!ac) return false;

      // frontierSign
      if (ac.frontierSign && !(ac.frontierSign as { __hooked?: boolean }).__hooked) {
        const orig = ac.frontierSign as (...a: unknown[]) => unknown;
        const hooked = function (this: unknown, ...args: unknown[]) {
          const calls = (window as unknown as { __allCalls: unknown[] }).__allCalls;
          let result: unknown;
          try {
            result = orig.apply(this, args);
            calls.push({
              fn: 'frontierSign',
              args: deepClone(args),
              result: typeof result === 'string' ? result.substring(0, 250) : deepClone(result),
              ts: Date.now(),
            });
          } catch (e) {
            calls.push({
              fn: 'frontierSign',
              args: deepClone(args),
              error: (e as Error).message,
              ts: Date.now(),
            });
            throw e;
          }
          return result;
        };
        (hooked as { __hooked?: boolean }).__hooked = true;
        ac.frontierSign = hooked;
        console.log('[HOOK] frontierSign hooked at ' + Date.now());
      }

      // _getSign (内部方法)
      const internalKeys = Object.keys(ac);
      for (const key of internalKeys) {
        const v = (ac as Record<string, unknown>)[key];
        if (typeof v === 'function' && !key.startsWith('__') && !(v as { __hooked?: boolean }).__hooked) {
          // 跳过初始化方法
          if (['init', 'setConfig', 'getReferer', 'getConfig', 'frontierSign', '_$_initialize', '_$_sign'].includes(key)) continue;
          const orig = v as (...a: unknown[]) => unknown;
          const hooked = function (this: unknown, ...args: unknown[]) {
            const calls = (window as unknown as { __allCalls: unknown[] }).__allCalls;
            let result: unknown;
            try {
              result = orig.apply(this, args);
              // 只记录可能与签名相关的调用
              if (JSON.stringify(args).length < 1000) {
                calls.push({
                  fn: key,
                  args: deepClone(args),
                  result: typeof result === 'string' ? result.substring(0, 100) : typeof result,
                  ts: Date.now(),
                });
              }
            } catch (e) {
              // ignore
            }
            return result;
          };
          (hooked as { __hooked?: boolean }).__hooked = true;
          (ac as Record<string, unknown>)[key] = hooked;
        }
      }

      return true;
    }

    let checkCount = 0;
    const interval = setInterval(() => {
      checkCount++;
      if (tryHook() || checkCount > 200) {
        clearInterval(interval);
        (window as unknown as { __hooked: boolean }).__hooked = true;
      }
    }, 100);
  });

  const page = await context.newPage();
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('HOOK') || text.includes('ERROR')) log.info(`[browser] ${text}`);
  });

  log.info('访问抖音主页加载 webmssdk...');
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(8000);

  log.info('手动调用 frontierSign...');
  const result = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const ac = w.byted_acrawler as Record<string, unknown> | undefined;
    if (!ac || !ac.frontierSign) return { error: 'no byted_acrawler' };

    // 试不同的参数组合
    const testUrl = '/aweme/v1/web/im/resource/sticker/collect/';
    const testParams = {
      device_platform: 'webapp',
      aid: '6383',
      app_id: '1128',
      channel: 'channel_pc_web',
      sec_user_id: 'MS4wLjABAAAA',
      sticker_id: 'test_id',
      sticker_type: '1',
      action: '1',
    };
    const r = (ac.frontierSign as (...a: unknown[]) => unknown)({
      url: testUrl,
      params: testParams,
      method: 'POST',
      body: '{}',
    });
    return {
      result: typeof r === 'string' ? r : JSON.stringify(r),
    };
  });
  log.info(`frontierSign 返回: ${JSON.stringify(result).substring(0, 300)}`);

  await page.waitForTimeout(3000);

  const calls = (await page.evaluate(() => {
    return (window as unknown as { __allCalls: unknown[] }).__allCalls || [];
  })) as Array<{ fn: string; args: unknown; result: string; ts: number }>;

  log.info(`\n=== 捕获 ${calls.length} 次调用 ===`);

  // 只显示 frontierSign 的完整 args
  const fsCalls = (calls as Array<{ fn: string; args: unknown; result: string; ts: number }>).filter((c) => c.fn === 'frontierSign');
  log.info(`frontierSign 调用次数: ${fsCalls.length}`);

  for (let i = 0; i < Math.min(fsCalls.length, 3); i++) {
    const c = fsCalls[i];
    log.info(`\n--- frontierSign 调用 ${i + 1} ---`);
    log.info(`  args[0] (前 1500 字符): ${JSON.stringify(c.args[0]).substring(0, 1500)}`);
    log.info(`  args[1] (前 500 字符): ${JSON.stringify(c.args[1]).substring(0, 500)}`);
    log.info(`  result: ${c.result}`);
  }

  // 也显示其他内部调用
  const otherCalls = calls.filter((c) => c.fn !== 'frontierSign');
  if (otherCalls.length > 0) {
    log.info(`\n--- 内部调用 (${otherCalls.length}) ---`);
    const fnNames = new Set<string>();
    for (const c of otherCalls) fnNames.add(c.fn);
    log.info(`  调用的内部方法: ${Array.from(fnNames).join(', ')}`);
  }

  await browser.close();
}

main().catch((e) => {
  log.error('失败', e);
  process.exit(1);
});
