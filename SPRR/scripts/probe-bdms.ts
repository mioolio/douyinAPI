/**
 * 在浏览器内加载 bdms.js JSVMP，调用其签名函数
 * bdms.js 是抖音用于生成 a_bogus 和 x-secsdk-web-signature 的 JSVMP
 */
import { chromium } from 'playwright';
import { resolveStorageState } from '../src/auth/accounts.js';
import { createLogger } from '../src/utils/logger.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const log = createLogger('probe-bdms');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

async function main() {
  // 读取 bdms.js
  const bdmsPath = path.join(__dirname, '..', 'data', 'capture', 'bdms.js');
  const bdmsCode = await fs.readFile(bdmsPath, 'utf-8');
  log.info(`bdms.js 大小: ${bdmsCode.length} 字符`);

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

  log.info('加载空白页...');
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(8000);

  // 把 bdms.js 注入到当前页面
  log.info('注入 bdms.js 到浏览器...');
  const injectResult = await page.evaluate(async (code: string) => {
    try {
      // 创建 script 标签
      const script = document.createElement('script');
      script.textContent = code;
      document.head.appendChild(script);
      // 等待初始化
      await new Promise((r) => setTimeout(r, 3000));

      // 查找全局对象
      const w = window as unknown as Record<string, unknown>;
      const keys = Object.keys(w).filter((k) => /bdms|byted|webms|a_bogus|abogus|secsdk/i.test(k));
      return {
        ok: true,
        keys,
        hasBdms: 'bdms' in w,
        hasBytedAcrawler: 'byted_acrawler' in w,
        bdmsType: typeof w.bdms,
        acType: typeof w.byted_acrawler,
      };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, bdmsCode);
  log.info(`注入结果: ${JSON.stringify(injectResult, null, 2)}`);

  // 列出所有全局对象
  const globals = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return Object.keys(w).filter(
      (k) => !k.startsWith('webkit') && !k.startsWith('chrome') && k.length < 50,
    );
  });
  log.info(`\n页面 globals (前 100): ${globals.slice(0, 100).join(', ')}`);

  await browser.close();
}

main().catch((e) => {
  log.error('失败', e);
  process.exit(1);
});
