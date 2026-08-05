#!/usr/bin/env tsx
/**
 * 深入查 window.openImConversation 和 window["@pc-im/im:1.0.0.696"]
 *
 * 已知：
 * - window.openImConversation 是函数
 * - window["@pc-im/im:1.0.0.696"] 是数组（长度 15，有 push 方法）
 *   → 这是 webpack chunk 数组，每项是 [chunkIds, modules] 格式
 *
 * 本脚本：
 * 1. 看 openImConversation 完整 toString
 * 2. 看 window["@pc-im/im:1.0.0.696"] 数组每项的结构（是 [chunkIds, modules] 还是别的）
 * 3. 尝试调用 get('.') 返回的函数，看真实导出
 * 4. 找 webpack require 函数
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
const OUTPUT_FILE = path.resolve(__dirname, '..', 'data', 'probe-im-globals-v2.json');

async function main() {
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

  const result = await page.evaluate(async () => {
    const out: Record<string, unknown> = {};

    // 1. openImConversation 完整函数体
    try {
      const fn = (window as unknown as Record<string, unknown>).openImConversation as Function;
      out.openImConversation = {
        type: typeof fn,
        name: fn?.name,
        length: fn?.length,
        snippet: fn?.toString().slice(0, 3000),
      };
    } catch (e) {
      out.openImConversationError = (e as Error).message;
    }

    // 2. window["@pc-im/im:1.0.0.696"] 数组
    try {
      const arr = (window as unknown as Record<string, unknown>)['@pc-im/im:1.0.0.696'] as unknown[];
      out.imArrayLength = arr?.length;
      const items: Record<string, unknown> = {};
      for (let i = 0; i < Math.min(arr.length, 15); i++) {
        const item = arr[i];
        const itemInfo: Record<string, unknown> = { type: typeof item };
        if (Array.isArray(item)) {
          itemInfo.isArray = true;
          itemInfo.length = item.length;
          // webpack chunk 格式：[chunkIds, modules]
          if (item.length >= 2) {
            itemInfo.chunkIds = Array.isArray(item[0]) ? item[0] : item[0];
            const modules = item[1];
            if (modules && typeof modules === 'object') {
              const modKeys = Object.keys(modules as object);
              itemInfo.moduleCount = modKeys.length;
              itemInfo.moduleKeys = modKeys.slice(0, 50);
              // 对每个模块函数，看 toString 找关键词
              const interestingModules: Record<string, string> = {};
              for (const mk of modKeys) {
                try {
                  const mf = (modules as Record<string, unknown>)[mk];
                  if (typeof mf === 'function') {
                    const src = (mf as Function).toString();
                    // 搜含 send/message/conversation 的
                    if (/send|message|conversation|sendMessage|getMessage/i.test(src)) {
                      interestingModules[mk] = src.slice(0, 800);
                    }
                  }
                } catch {
                  // ignore
                }
              }
              if (Object.keys(interestingModules).length > 0) {
                itemInfo.interestingModules = interestingModules;
              }
            }
          }
        } else if (typeof item === 'function') {
          itemInfo.snippet = (item as Function).toString().slice(0, 500);
        }
        items[String(i)] = itemInfo;
      }
      out.imArrayItems = items;
    } catch (e) {
      out.imArrayError = (e as Error).message;
    }

    // 3. 尝试调用 get('.') 返回的函数
    try {
      const vmokIm = (window as unknown as Record<string, unknown>)[
        '__VMOK_@pc-im/im:1.0.0.696__'
      ] as { get?: (name?: string) => Promise<unknown> };
      if (vmokIm?.get) {
        const loaderFn = await vmokIm.get('.');
        if (typeof loaderFn === 'function') {
          // 调用这个函数
          const mod = await (loaderFn as () => Promise<unknown>)();
          out.calledGetDotResult = {
            type: typeof mod,
            keys: mod && typeof mod === 'object' ? Object.keys(mod).slice(0, 50) : null,
            name: (mod as Function)?.name,
          };
          if (mod && typeof mod === 'object') {
            const details: Record<string, unknown> = {};
            for (const k of Object.keys(mod).slice(0, 30)) {
              try {
                const v = (mod as Record<string, unknown>)[k];
                const d: Record<string, unknown> = { type: typeof v };
                if (typeof v === 'function') {
                  d.snippet = (v as Function).toString().slice(0, 500);
                  if (v.prototype && typeof v.prototype === 'object') {
                    const methods: string[] = [];
                    let proto = v.prototype;
                    while (proto && proto !== Object.prototype) {
                      for (const n of Object.getOwnPropertyNames(proto)) {
                        if (n !== 'constructor' && typeof (proto as Record<string, unknown>)[n] === 'function') {
                          methods.push(n);
                        }
                      }
                      proto = Object.getPrototypeOf(proto);
                    }
                    if (methods.length > 0) d.protoMethods = methods;
                  }
                } else if (typeof v === 'object' && v !== null) {
                  d.keys = Object.keys(v).slice(0, 20);
                }
                details[k] = d;
              } catch (e) {
                details[k] = { error: (e as Error).message };
              }
            }
            out.calledGetDotDetails = details;
          }
        }
      }
    } catch (e) {
      out.calledGetDotError = (e as Error).message;
    }

    // 4. 找 webpack require 函数（全局 push 到数组的函数）
    // 当 webpack chunk 加载时，它会调用 window["xxx"].push([[chunkIds], {modules}])
    // 这个 push 是被改写过的，实际是 webpack push 函数
    try {
      const arr = (window as unknown as Record<string, unknown>)['@pc-im/im:1.0.0.696'] as
        | unknown[]
        | { push?: Function };
      if (arr && typeof arr === 'object') {
        const pushFn = (arr as { push?: Function }).push;
        if (typeof pushFn === 'function') {
          out.webpackPushSnippet = pushFn.toString().slice(0, 2000);
        }
      }
    } catch (e) {
      out.webpackPushError = (e as Error).message;
    }

    return out;
  });

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
