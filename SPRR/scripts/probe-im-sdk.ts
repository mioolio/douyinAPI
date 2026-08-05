#!/usr/bin/env tsx
/**
 * 探查抖音页面的 IM SDK 全局对象
 *
 * 目标：找出 window 上暴露的 IM 相关全局变量、函数、对象。
 * 如果抖音前端把 IM SDK 挂到 window 上（如 window.__im_sdk、window.byted_acrawler 等），
 * 我们可以直接调用，省去自己构造签名和 protobuf。
 *
 * 探查内容：
 * 1. window 上所有含 im/chat/send/message/conversation/frontier 关键词的属性
 * 2. 已知的抖音风控全局对象：byted_acrawler、_bd_ticket_guard、webmssdk、msToken
 * 3. localStorage / sessionStorage 中的关键数据
 * 4. document.cookie 中的关键 cookie（不输出值，只输出 name 列表）
 * 5. WebSocket 连接列表（performance.getEntriesByType('resource') 过滤 ws/wss）
 * 6. fetch / XMLHttpRequest 是否被改写（toString 看是否原生）
 *
 * 用法：npx tsx scripts/probe-im-sdk.ts
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

const OUTPUT_FILE = path.resolve(__dirname, '..', 'data', 'probe-im-sdk.json');

const KEYWORDS = [
  'im',
  'chat',
  'send',
  'message',
  'msg',
  'conversation',
  'frontier',
  'byted',
  'acrawler',
  'ticket',
  'guard',
  'webmssdk',
  'mssdk',
  'mstoken',
  'bogus',
  'sign',
  'sdk',
  'imapi',
  'aweme',
];

async function main() {
  console.log('启动浏览器（headful，便于观察）...');
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

  // 反检测
  await context.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = window.chrome || { runtime: {} };
  `);

  const page = await context.newPage();
  console.log('打开抖音聊天页...');
  await page.goto('https://www.douyin.com/chat?isPopup=1', {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  // 等页面加载完整
  console.log('等待页面加载完整（15s）...');
  await page.waitForTimeout(15000);

  console.log('开始探查 window 全局对象...');
  const result = await page.evaluate((keywords: string[]) => {
    const found: Record<string, unknown> = {};

    // 1. 扫 window 顶层属性
    const windowKeys = Object.getOwnPropertyNames(window);
    for (const key of windowKeys) {
      const lowerKey = key.toLowerCase();
      if (keywords.some((kw) => lowerKey.includes(kw))) {
        try {
          const val = (window as unknown as Record<string, unknown>)[key];
          found[`window.${key}`] = {
            type: typeof val,
            isFunction: typeof val === 'function',
            keys:
              val && typeof val === 'object'
                ? Object.keys(val).slice(0, 30)
                : undefined,
            snippet: (() => {
              try {
                if (typeof val === 'function') {
                  return val.toString().slice(0, 300);
                }
                if (typeof val === 'string') return val.slice(0, 300);
                return undefined;
              } catch {
                return undefined;
              }
            })(),
          };
        } catch {
          // ignore
        }
      }
    }

    // 2. 扫 window.__ 开头的内部变量
    for (const key of windowKeys) {
      if (key.startsWith('__')) {
        try {
          const val = (window as unknown as Record<string, unknown>)[key];
          found[`window.${key}`] = {
            type: typeof val,
            keys:
              val && typeof val === 'object'
                ? Object.keys(val).slice(0, 30)
                : undefined,
          };
        } catch {
          // ignore
        }
      }
    }

    // 3. localStorage 关键数据
    const storage: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      const lowerK = k.toLowerCase();
      if (keywords.some((kw) => lowerK.includes(kw))) {
        const v = localStorage.getItem(k) || '';
        storage[k] = v.slice(0, 500);
      }
    }

    // 4. cookie name 列表
    const cookieNames = document.cookie
      .split(';')
      .map((c) => c.trim().split('=')[0])
      .filter(Boolean);

    // 5. WebSocket 连接
    const wsEntries = performance
      .getEntriesByType('resource')
      .filter((e) => e.name.startsWith('ws://') || e.name.startsWith('wss://'))
      .map((e) => ({ url: e.name, duration: e.duration }));

    // 6. fetch / XHR 是否原生
    const nativeCheck = {
      fetchNative: window.fetch.toString().includes('[native code]'),
      xhrOpenNative: XMLHttpRequest.prototype.open.toString().includes('[native code]'),
    };

    // 7. 查找疑似 IM SDK 的 require 模块
    const webpackModules: string[] = [];
    try {
      const chunks = (window as unknown as Record<string, unknown>).webpackChunk_N_E;
      if (Array.isArray(chunks)) {
        for (const chunk of chunks) {
          if (Array.isArray(chunk) && chunk[1]) {
            const modules = chunk[1] as Record<string, unknown>;
            for (const name of Object.keys(modules)) {
              const fn = modules[name] as Function;
              const src = fn.toString();
              if (keywords.some((kw) => src.toLowerCase().includes(kw))) {
                webpackModules.push(`chunk#${name}: ${src.slice(0, 200)}`);
              }
            }
          }
        }
      }
    } catch {
      // ignore
    }

    return {
      foundGlobals: found,
      storage,
      cookieNames,
      wsEntries,
      nativeCheck,
      webpackModules: webpackModules.slice(0, 50),
    };
  }, KEYWORDS);

  // 保存
  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log(`探查结果已保存: ${OUTPUT_FILE}`);
  console.log(`发现全局对象: ${Object.keys(result.foundGlobals).length} 个`);
  console.log(`WebSocket 连接: ${result.wsEntries.length} 个`);
  console.log(`webpack 模块: ${result.webpackModules.length} 个`);

  // 浏览器保持打开，让用户也能手动检查
  console.log('\n浏览器保持打开，可手动在 devtools console 检查。');
  console.log('按 Ctrl+C 关闭浏览器退出。');

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
