#!/usr/bin/env tsx
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STORAGE_STATE = path.resolve(
  __dirname, '..', '..', 'ccc', 'data', 'storageState.json',
);
const OUTPUT_FILE = path.resolve(__dirname, '..', 'data', 'instance-detail.json');
const SCRIPT_FILE = path.resolve(__dirname, 'probe-instance-detail.js');

async function main() {
  const scriptContent = await fs.readFile(SCRIPT_FILE, 'utf-8');
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--window-size=1400,900'],
  });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    storageState: STORAGE_STATE,
  });
  await context.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = window.chrome || { runtime: {} };
  `);
  const page = await context.newPage();
  await page.goto('https://www.douyin.com/chat?isPopup=1', {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForTimeout(15000);

  const result = await page.evaluate(scriptContent);
  console.log(JSON.stringify(result, null, 2));
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(`\n保存到: ${OUTPUT_FILE}`);

  console.log('\n浏览器保持打开，按 Ctrl+C 退出。');
  await new Promise<void>((resolve) => {
    const handler = () => {
      process.off('SIGINT', handler);
      resolve();
    };
    process.on('SIGINT', handler);
  });
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
