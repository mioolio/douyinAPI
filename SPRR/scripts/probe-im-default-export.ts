#!/usr/bin/env tsx
/**
 * 深入探查 vmokIm.get('.') 返回的默认导出
 *
 * 已知：
 * - get('.') 返回 function（class 或工厂）
 * - 远程入口含 __federation_expose_default_export.d40e64ca.js
 *
 * 本脚本：
 * 1. 拿到 get('.') 返回的 function，看完整 toString
 * 2. 看 prototype 上的方法（class 的实例方法）
 * 3. 看静态属性和方法
 * 4. 尝试 new 实例化（如果签名像 class）
 * 5. 检查是否单例（可能已实例化，挂在某全局变量）
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
const OUTPUT_FILE = path.resolve(__dirname, '..', 'data', 'probe-im-default.json');

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

    const vmokIm = (window as unknown as Record<string, unknown>)[
      '__VMOK_@pc-im/im:1.0.0.696__'
    ] as { get?: (name?: string) => Promise<unknown> };

    if (!vmokIm?.get) {
      out.error = 'vmokIm.get not found';
      return out;
    }

    // 拿到默认导出
    const defaultExport = await vmokIm.get('.');
    out.type = typeof defaultExport;
    out.name = (defaultExport as Function)?.name;
    out.length = (defaultExport as Function)?.length;

    // 1. 完整 toString（前 5000 字符）
    if (typeof defaultExport === 'function') {
      out.fullSnippet = defaultExport.toString().slice(0, 5000);

      // 2. 静态属性
      const staticProps: Record<string, unknown> = {};
      for (const k of Object.getOwnPropertyNames(defaultExport)) {
        if (k === 'name' || k === 'length' || k === 'prototype' || k === 'caller' || k === 'arguments') continue;
        try {
          const v = (defaultExport as Record<string, unknown>)[k];
          staticProps[k] = {
            type: typeof v,
            value: typeof v === 'function' ? v.toString().slice(0, 200) : String(v).slice(0, 200),
          };
        } catch (e) {
          staticProps[k] = { error: (e as Error).message };
        }
      }
      out.staticProps = staticProps;

      // 3. prototype 方法
      if (defaultExport.prototype && typeof defaultExport.prototype === 'object') {
        const protoMethods: Record<string, string> = {};
        let proto = defaultExport.prototype;
        let depth = 0;
        while (proto && proto !== Object.prototype && depth < 5) {
          for (const name of Object.getOwnPropertyNames(proto)) {
            if (name === 'constructor') continue;
            try {
              const fn = Object.getOwnPropertyDescriptor(proto, name)?.value;
              if (typeof fn === 'function') {
                protoMethods[name] = fn.toString().slice(0, 500);
              }
            } catch (e) {
              protoMethods[name] = `ERROR: ${(e as Error).message}`;
            }
          }
          proto = Object.getPrototypeOf(proto);
          depth++;
        }
        out.protoMethods = protoMethods;
      }
    }

    // 4. 检查全局对象上是否有已实例化的 IM
    // 常见命名：window.im / window.IM / window.pcIM / window.chatStore
    const globalKeys = Object.getOwnPropertyNames(window);
    const imLike: Record<string, unknown> = {};
    for (const k of globalKeys) {
      const lower = k.toLowerCase();
      if (
        (lower.includes('im') || lower.includes('chat') || lower.includes('message')) &&
        !lower.includes('image') &&
        !lower.includes('img') &&
        !lower.includes('ime') &&
        !lower.includes('import') &&
        !lower.includes('iframe')
      ) {
        try {
          const v = (window as unknown as Record<string, unknown>)[k];
          if (v && (typeof v === 'object' || typeof v === 'function')) {
            imLike[k] = {
              type: typeof v,
              keys: typeof v === 'object' ? Object.keys(v).slice(0, 20) : null,
            };
          }
        } catch {
          // ignore
        }
      }
    }
    out.imLikeGlobals = imLike;

    // 5. 查找 mobx store（IM 通常用 mobx）
    try {
      const mobxGlobals = (window as unknown as Record<string, unknown>).__mobxGlobals;
      if (mobxGlobals && typeof mobxGlobals === 'object') {
        const mg = mobxGlobals as { version?: unknown; default?: unknown };
        out.mobxGlobalsVersion = mg.version;
        if (mg.default && typeof mg.default === 'object') {
          out.mobxDefaultKeys = Object.keys(mg.default as object).slice(0, 30);
        }
      }
    } catch (e) {
      out.mobxError = (e as Error).message;
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
