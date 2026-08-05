#!/usr/bin/env tsx
/**
 * 从 React fiber 树中提取已初始化的 IM SDK 实例
 *
 * 关键修复：evaluate 脚本放到独立 .js 文件，运行时读取
 * （避免 tsx 把模板字符串里的代码当 TS 处理，注入 __name helper）
 */

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STORAGE_STATE = path.resolve(
  __dirname,
  '..',
  '..',
  'ccc',
  'data',
  'storageState.json',
);
const OUTPUT_FILE = path.resolve(__dirname, '..', 'data', 'im-instance.json');
const SCRIPT_FILE = path.resolve(__dirname, 'extract-im-instance.js');

async function main() {
  // 读取纯 JS 脚本文件
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

  // 直接传字符串给 evaluate（Playwright 会 eval 这个字符串）
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
