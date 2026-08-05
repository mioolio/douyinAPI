#!/usr/bin/env tsx
/**
 * 探查 VMOK IM SDK 实例的方法
 *
 * 已知：
 * - window.__VMOK_@pc-im/im:1.0.0.696__ 存在，有 get 和 init 方法
 * - window.__VMOK__ 也有 __INSTANCES__、moduleInfo 等
 *
 * 本脚本尝试：
 * 1. 调用 vmokIm.get() 拿到 IM SDK 模块导出
 * 2. 列出模块导出的所有属性/方法
 * 3. 查找含 send/message/conversation/create 等关键词的方法
 * 4. 如果是 class，看 prototype 上的方法
 * 5. 尝试 init 初始化（如果需要）
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

const OUTPUT_FILE = path.resolve(__dirname, '..', 'data', 'probe-vmok-im.json');

async function main() {
  console.log('启动浏览器...');
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
  console.log('打开抖音聊天页...');
  await page.goto('https://www.douyin.com/chat?isPopup=1', {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  console.log('等待 15s 让 SDK 加载完整...');
  await page.waitForTimeout(15000);

  console.log('探查 VMOK IM SDK...');

  const result = await page.evaluate(async () => {
    const out: Record<string, unknown> = {};

    // 1. 拿到 vmokIm 模块对象
    const vmokIm = (window as unknown as Record<string, unknown>)[
      '__VMOK_@pc-im/im:1.0.0.696__'
    ] as { get?: Function; init?: Function } | undefined;

    if (!vmokIm) {
      out.error = 'vmokIm not found';
      return out;
    }

    out.vmokImKeys = Object.keys(vmokIm);

    // 2. 尝试调用 get() 拿到模块导出
    try {
      const mod = vmokIm.get ? await vmokIm.get() : null;
      out.modType = typeof mod;
      if (mod && typeof mod === 'object') {
        out.modKeys = Object.keys(mod);
        // 详细列出每个属性的类型和 snippet
        const details: Record<string, unknown> = {};
        for (const k of Object.keys(mod)) {
          try {
            const v = (mod as Record<string, unknown>)[k];
            const detail: Record<string, unknown> = {
              type: typeof v,
            };
            if (typeof v === 'function') {
              detail.snippet = v.toString().slice(0, 500);
              // 看 prototype 上的方法（如果是 class）
              if (v.prototype && typeof v.prototype === 'object') {
                const protoMethods: string[] = [];
                let proto = v.prototype;
                while (proto && proto !== Object.prototype) {
                  for (const name of Object.getOwnPropertyNames(proto)) {
                    if (name !== 'constructor' && typeof (proto as Record<string, unknown>)[name] === 'function') {
                      protoMethods.push(name);
                    }
                  }
                  proto = Object.getPrototypeOf(proto);
                }
                if (protoMethods.length > 0) {
                  detail.protoMethods = protoMethods;
                }
              }
            } else if (typeof v === 'object' && v !== null) {
              detail.keys = Object.keys(v).slice(0, 20);
            } else {
              detail.value = String(v).slice(0, 200);
            }
            details[k] = detail;
          } catch (e) {
            details[k] = { error: (e as Error).message };
          }
        }
        out.modDetails = details;
      }
    } catch (e) {
      out.getError = (e as Error).message;
    }

    // 3. 尝试调用 init() 看是否会初始化
    try {
      if (typeof vmokIm.init === 'function') {
        // 不真的调用，只看函数签名
        out.initSnippet = vmokIm.init.toString().slice(0, 500);
      }
    } catch (e) {
      out.initError = (e as Error).message;
    }

    // 4. 看 __VMOK__.__INSTANCES__ 是否已有 IM 实例
    try {
      const vmok = (window as unknown as Record<string, unknown>).__VMOK__ as {
        __INSTANCES__?: unknown;
        moduleInfo?: unknown;
      } | undefined;
      if (vmok) {
        out.vmokInstancesType = typeof vmok.__INSTANCES__;
        if (vmok.__INSTANCES__ && typeof vmok.__INSTANCES__ === 'object') {
          out.vmokInstancesKeys = Object.keys(vmok.__INSTANCES__ as object);
        }
        out.moduleInfoType = typeof vmok.moduleInfo;
        if (vmok.moduleInfo && typeof vmok.moduleInfo === 'object') {
          out.moduleInfoKeys = Object.keys(vmok.moduleInfo as object);
        }
      }
    } catch (e) {
      out.vmokInstancesError = (e as Error).message;
    }

    return out;
  });

  console.log('\n探查结果:');
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
