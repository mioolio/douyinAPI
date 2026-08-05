/**
 * 在浏览器内调用 bdms 签名函数获取 a_bogus + x-secsdk-web-signature
 */
import { chromium } from 'playwright';
import { resolveStorageState } from '../src/auth/accounts.js';
import { createLogger } from '../src/utils/logger.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const log = createLogger('probe-bdms2');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

async function main() {
  const bdmsPath = path.join(__dirname, '..', 'data', 'capture', 'bdms.js');
  const bdmsCode = await fs.readFile(bdmsPath, 'utf-8');

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

  const page = await context.newPage();
  page.on('console', (msg) => {
    log.info(`[browser] ${msg.text()}`);
  });
  page.on('pageerror', (e) => {
    log.error(`[browser error] ${e.message}`);
  });

  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(8000);

  // 注入 bdms.js
  log.info('注入 bdms.js...');
  await page.evaluate((code: string) => {
    const script = document.createElement('script');
    script.textContent = code;
    document.head.appendChild(script);
  }, bdmsCode);
  await page.waitForTimeout(3000);

  // 详细探测 bdms 对象
  const bdmsInfo = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const bdms = w.bdms as Record<string, unknown> | undefined;
    if (!bdms) return { error: 'no bdms' };
    return {
      bdmsType: typeof bdms,
      bdmsKeys: Object.keys(bdms),
      bdmsProtoKeys: bdms.prototype ? Object.keys(bdms.prototype as object) : [],
      isFunction: typeof bdms === 'function',
    };
  });
  log.info(`bdms 信息: ${JSON.stringify(bdmsInfo, null, 2)}`);

  // 探测 byted_acrawler
  const acInfo = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const ac = w.byted_acrawler as Record<string, unknown> | undefined;
    if (!ac) return { error: 'no byted_acrawler' };
    return {
      acKeys: Object.keys(ac),
      acProtoKeys: ac.prototype ? Object.keys(ac.prototype as object) : [],
    };
  });
  log.info(`byted_acrawler 信息: ${JSON.stringify(acInfo, null, 2)}`);

  // 探测 useWebSecsdkApi
  const secInfo = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const sec = w.useWebSecsdkApi as Record<string, unknown> | undefined;
    if (!sec) return { error: 'no useWebSecsdkApi' };
    return {
      secType: typeof sec,
      secKeys: Object.keys(sec),
    };
  });
  log.info(`useWebSecsdkApi 信息: ${JSON.stringify(secInfo, null, 2)}`);

  // 尝试以多种方式调用 byted_acrawler.frontierSign 获取 a_bogus
  log.info('\n=== 尝试不同调用方式 ===');
  const callResults = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const ac = w.byted_acrawler as Record<string, unknown> | undefined;
    const bdms = w.bdms as Record<string, unknown> | undefined;
    const out: Array<{ method: string; args: unknown; result: unknown; error?: string }> = [];

    const testArgs = {
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
    };

    // 方法 1: byted_acrawler.frontierSign(args)
    if (ac?.frontierSign) {
      try {
        const r = (ac.frontierSign as (...a: unknown[]) => unknown).call(ac, testArgs);
        out.push({ method: 'byted_acrawler.frontierSign(args)', args: testArgs, result: r });
      } catch (e) {
        out.push({ method: 'byted_acrawler.frontierSign(args)', args: testArgs, result: null, error: (e as Error).message });
      }
    }

    // 方法 2: new byted_acrawler().frontierSign(args)
    if (typeof ac === 'function') {
      try {
        const inst = new (ac as new () => Record<string, unknown>)();
        if (inst.frontierSign) {
          const r = (inst.frontierSign as (...a: unknown[]) => unknown).call(inst, testArgs);
          out.push({ method: 'new byted_acrawler().frontierSign(args)', args: testArgs, result: r });
        } else {
          out.push({ method: 'new byted_acrawler()', args: testArgs, result: null, error: 'no frontierSign' });
        }
      } catch (e) {
        out.push({ method: 'new byted_acrawler()', args: testArgs, result: null, error: (e as Error).message });
      }
    }

    // 方法 3: bdms
    if (bdms) {
      out.push({ method: 'bdms inspect', args: null, result: { keys: Object.keys(bdms) } });
    }

    return out;
  });
  log.info(`调用结果: ${JSON.stringify(callResults, null, 2)}`);

  await browser.close();
}

main().catch((e) => {
  log.error('失败', e);
  process.exit(1);
});
