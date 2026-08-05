/**
 * 深度捕获 webmssdk frontierSign 内部调用：使用 console.log 实时输出
 *
 * 改进点：
 *   1. 不依赖 setInterval 找 byted_acrawler，改用 MutationObserver + 定时器双重保险
 *   2. 每次检测到 frontierSign 时立即安装 hook
 *   3. 通过 console.log 把捕获信息实时输出
 *   4. 触发真实的 API 请求（发消息、拉列表等）
 */
import { chromium } from 'playwright';
import { resolveStorageState } from '../src/auth/accounts.js';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('probe-frontier-deep-v2');

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

    const w = window as unknown as Record<string, unknown>;
    (w.__allCalls as unknown[]) = [];
    (w.__hookedOk as boolean) = false;

    function safeStr(v: unknown, max = 200): string {
      if (v == null) return String(v);
      if (typeof v === 'string') return v.length > max ? v.substring(0, max) + '...' : v;
      try {
        return JSON.stringify(v).substring(0, max);
      } catch {
        return '[unserializable]';
      }
    }

    function installHook(): boolean {
      const ac = w.byted_acrawler as Record<string, unknown> | undefined;
      if (!ac) return false;

      let hookedAny = false;

      // frontierSign
      const fs = ac.frontierSign as (Record<string, unknown> & ((...a: unknown[]) => unknown)) | undefined;
      if (fs && typeof fs === 'function' && !fs.__hooked) {
        const orig = fs as (...a: unknown[]) => unknown;
        const hooked = function (this: unknown, ...args: unknown[]) {
          let r: unknown;
          try {
            r = orig.apply(this, args);
            (w.__allCalls as unknown[]).push({
              fn: 'frontierSign',
              args0: safeStr(args[0], 1500),
              result: safeStr(r, 250),
              ts: Date.now(),
            });
            console.log('[FRONTIER_HOOK] args=' + safeStr(args[0], 400) + ' result=' + safeStr(r, 100));
          } catch (e) {
            (w.__allCalls as unknown[]).push({
              fn: 'frontierSign',
              args0: safeStr(args[0], 1500),
              error: (e as Error).message,
              ts: Date.now(),
            });
            console.log('[FRONTIER_HOOK] ERROR ' + (e as Error).message);
            throw e;
          }
          return r;
        };
        (hooked as { __hooked: boolean }).__hooked = true;
        ac.frontierSign = hooked;
        console.log('[HOOK_INSTALLED] frontierSign');
        hookedAny = true;
      }

      // 也尝试 hook byted_acrawler 上的所有函数（包括签名的内部方法）
      const keys = Object.keys(ac);
      for (const key of keys) {
        if (key === 'frontierSign') continue;
        const v = (ac as Record<string, unknown>)[key];
        if (typeof v === 'function' && !key.startsWith('__') && !(v as { __hooked?: boolean }).__hooked) {
          // 跳过非签名相关方法
          if (['init', 'setConfig', 'getReferer', 'getConfig'].includes(key)) continue;
          const orig = v as (...a: unknown[]) => unknown;
          const hooked = function (this: unknown, ...args: unknown[]) {
            let r: unknown;
            try {
              r = orig.apply(this, args);
              if (typeof r === 'string' && r.length > 0) {
                console.log('[INTERNAL_CALL] ' + key + ' args=' + safeStr(args, 200) + ' result=' + safeStr(r, 80));
                (w.__allCalls as unknown[]).push({
                  fn: key,
                  args0: safeStr(args[0], 800),
                  result: safeStr(r, 80),
                  ts: Date.now(),
                });
              } else {
                (w.__allCalls as unknown[]).push({
                  fn: key,
                  args0: safeStr(args[0], 800),
                  resultType: typeof r,
                  ts: Date.now(),
                });
              }
            } catch {
              // ignore
            }
            return r;
          };
          (hooked as { __hooked: boolean }).__hooked = true;
          (ac as Record<string, unknown>)[key] = hooked;
        }
      }

      return hookedAny;
    }

    // 1. MutationObserver 监听 DOM 变化
    const mo = new MutationObserver(() => {
      if (!w.__hookedOk) {
        if (installHook()) {
          (w.__hookedOk as boolean) = true;
        }
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

    // 2. 定时器保险：每 200ms 检查
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      if (!w.__hookedOk) {
        if (installHook()) {
          (w.__hookedOk as boolean) = true;
        }
      }
      if (attempts > 100 || w.__hookedOk) {
        clearInterval(interval);
        console.log('[HOOK_DONE] hooked=' + w.__hookedOk + ' after ' + attempts + ' attempts');
      }
    }, 200);
  });

  const page = await context.newPage();
  const calls: Array<{ fn: string; args0: string; result?: string; resultType?: string; error?: string; ts: number }> = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('[HOOK_') || text.startsWith('[FRONTIER_') || text.startsWith('[INTERNAL_')) {
      log.info(`[browser] ${text}`);
    }
  });
  page.on('console', async (msg) => {
    const text = msg.text();
    if (text.startsWith('[FRONTIER_HOOK]')) {
      const m = text.match(/\[FRONTIER_HOOK\] args=(.*?) result=(.*)$/);
      if (m) {
        calls.push({
          fn: 'frontierSign',
          args0: m[1] || '',
          result: m[2] || '',
          ts: Date.now(),
        });
      }
    }
  });

  // 拦截所有 a_bogus 请求
  const capturedUrls: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('a_bogus=') || url.includes('X-Bogus')) {
      capturedUrls.push(`${req.method()} ${url.substring(0, 400)}`);
    }
  });

  log.info('访问抖音主页加载 webmssdk...');
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(8000);

  // 1. 手动调用 frontierSign 触发一次
  log.info('手动调用 frontierSign...');
  const result1 = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const ac = w.byted_acrawler as Record<string, unknown> | undefined;
    if (!ac || !ac.frontierSign) return { error: 'no byted_acrawler.frontierSign' };
    const r = (ac.frontierSign as (...a: unknown[]) => unknown)({
      url: '/aweme/v1/web/aweme/post/',
      params: {
        device_platform: 'webapp',
        aid: '6383',
        channel: 'channel_pc_web',
        sec_user_id: 'MS4wLjABAAAA',
        max_cursor: '0',
        count: '18',
      },
      method: 'GET',
    });
    return { result: typeof r === 'string' ? r : JSON.stringify(r) };
  });
  log.info(`frontierSign 返回: ${JSON.stringify(result1).substring(0, 400)}`);

  // 2. 触发真实业务：导航到聊天页（这会触发大量 API 调用）
  log.info('导航到 follow 页面触发业务调用...');
  await page.goto('https://www.douyin.com/follow', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(8000);

  // 3. 等钩子信息收集
  await page.waitForTimeout(3000);

  // 4. 拉取 __allCalls
  const allCalls = await page.evaluate(() => {
    return (window as unknown as { __allCalls: unknown[] }).__allCalls || [];
  });
  const hookedOk = await page.evaluate(() => (window as unknown as { __hookedOk: boolean }).__hookedOk);

  log.info(`\n=== Hook 安装状态: ${hookedOk} ===`);
  log.info(`=== console 捕获: ${calls.length} 次 frontierSign ===`);
  log.info(`=== __allCalls 捕获: ${allCalls.length} 次调用 ===`);
  log.info(`=== capturedUrls (a_bogus/X-Bogus): ${capturedUrls.length} ===`);

  if (capturedUrls.length > 0) {
    log.info(`\n--- 真实业务请求 (a_bogus/X-Bogus) ---`);
    for (const u of capturedUrls.slice(0, 10)) {
      log.info(`  ${u}`);
    }
  }

  // 详细输出 frontierSign args
  log.info(`\n--- console 捕获的 frontierSign (前 5) ---`);
  for (let i = 0; i < Math.min(calls.length, 5); i++) {
    const c = calls[i];
    log.info(`  args[0]: ${c.args0}`);
    log.info(`  result:  ${c.result}`);
  }

  // 详细输出 __allCalls
  log.info(`\n--- __allCalls frontierSign 详情 (前 5) ---`);
  const fsCalls = (allCalls as Array<{ fn: string; args0: string; result?: string; error?: string }>).filter((c) => c.fn === 'frontierSign');
  for (let i = 0; i < Math.min(fsCalls.length, 5); i++) {
    const c = fsCalls[i];
    log.info(`  ${i + 1}. args0: ${c.args0.substring(0, 600)}`);
    log.info(`     result: ${c.result?.substring(0, 200)}`);
  }

  // 内部调用
  const otherCalls = (allCalls as Array<{ fn: string; args0: string; result?: string; resultType?: string }>).filter((c) => c.fn !== 'frontierSign');
  const fnSet = new Set(otherCalls.map((c) => c.fn));
  log.info(`\n--- 内部方法调用 ---`);
  log.info(`  调用过的方法 (${fnSet.size}): ${Array.from(fnSet).join(', ')}`);
  for (const fn of Array.from(fnSet).slice(0, 30)) {
    const c = otherCalls.find((x) => x.fn === fn);
    if (c) {
      log.info(`  ${fn}(${c.args0.substring(0, 80)}) -> ${c.result?.substring(0, 60) || c.resultType}`);
    }
  }

  await browser.close();
}

main().catch((e) => {
  log.error('失败', e);
  process.exit(1);
});
