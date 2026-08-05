#!/usr/bin/env tsx
/**
 * 探查 VMOK 已加载的实例
 *
 * 已知：
 * - vmokIm.get() 不带参数报错 "Module \"undefined\" does not exist"
 *   → 需要传具体模块名，如 get('./index') 或 get('./MessageService')
 * - __VMOK__.__INSTANCES__ 有 0 和 1 两个实例
 *
 * 本脚本：
 * 1. 深入查看 __INSTANCES__[0] 和 __INSTANCES__[1] 的结构
 * 2. 尝试 vmokIm.get('./xxx') 各种常见入口名
 * 3. 看 moduleInfo 中 @pc-im/im 的完整信息
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

const OUTPUT_FILE = path.resolve(__dirname, '..', 'data', 'probe-vmok-instances.json');

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

    // 1. 深入查看 __INSTANCES__
    const vmok = (window as unknown as Record<string, unknown>).__VMOK__ as {
      __INSTANCES__?: Record<string, unknown>;
      moduleInfo?: Record<string, unknown>;
      __SHARE__?: unknown;
      __PRELOADED_MAP__?: unknown;
      __MANIFEST_LOADING__?: unknown;
    };

    if (vmok?.__INSTANCES__) {
      const instances = vmok.__INSTANCES__;
      const instDetails: Record<string, unknown> = {};
      for (const key of Object.keys(instances)) {
        const inst = instances[key];
        const detail: Record<string, unknown> = {
          type: typeof inst,
        };
        if (inst && typeof inst === 'object') {
          detail.keys = Object.keys(inst).slice(0, 30);
          // 看每个属性的类型
          const subDetails: Record<string, unknown> = {};
          for (const k of Object.keys(inst).slice(0, 30)) {
            try {
              const v = (inst as Record<string, unknown>)[k];
              const subDetail: Record<string, unknown> = { type: typeof v };
              if (typeof v === 'function') {
                subDetail.snippet = v.toString().slice(0, 300);
                if (v.prototype && typeof v.prototype === 'object') {
                  const methods: string[] = [];
                  let proto = v.prototype;
                  while (proto && proto !== Object.prototype) {
                    for (const name of Object.getOwnPropertyNames(proto)) {
                      if (name !== 'constructor' && typeof (proto as Record<string, unknown>)[name] === 'function') {
                        methods.push(name);
                      }
                    }
                    proto = Object.getPrototypeOf(proto);
                  }
                  if (methods.length > 0) subDetail.protoMethods = methods;
                }
              } else if (typeof v === 'object' && v !== null) {
                subDetail.keys = Object.keys(v).slice(0, 20);
              }
              subDetails[k] = subDetail;
            } catch (e) {
              subDetails[k] = { error: (e as Error).message };
            }
          }
          detail.subDetails = subDetails;
        }
        instDetails[key] = detail;
      }
      out.instances = instDetails;
    }

    // 2. 看 __SHARE__
    if (vmok?.__SHARE__) {
      out.shareType = typeof vmok.__SHARE__;
      if (typeof vmok.__SHARE__ === 'object' && vmok.__SHARE__) {
        out.shareKeys = Object.keys(vmok.__SHARE__ as object).slice(0, 30);
      }
    }

    // 3. 看 __PRELOADED_MAP__
    if (vmok?.__PRELOADED_MAP__) {
      out.preloadedMapType = typeof vmok.__PRELOADED_MAP__;
      if (typeof vmok.__PRELOADED_MAP__ === 'object' && vmok.__PRELOADED_MAP__) {
        out.preloadedMapKeys = Object.keys(vmok.__PRELOADED_MAP__ as object).slice(0, 30);
      }
    }

    // 4. 看 moduleInfo 完整
    if (vmok?.moduleInfo) {
      out.moduleInfo = vmok.moduleInfo;
    }

    // 5. 尝试 vmokIm.get(各种入口名)
    const vmokIm = (window as unknown as Record<string, unknown>)[
      '__VMOK_@pc-im/im:1.0.0.696__'
    ] as { get?: (name?: string) => Promise<unknown> };

    if (vmokIm?.get) {
      const tryNames = [
        './index',
        './Index',
        './main',
        './Main',
        './IM',
        './im',
        './IMClient',
        './imClient',
        './MessageService',
        './messageService',
        './ConversationService',
        './conversationService',
        './default',
        './Default',
        './export',
        './Export',
        '.',
        './',
        '',
        '*',
      ];
      const getResults: Record<string, unknown> = {};
      for (const name of tryNames) {
        try {
          const mod = await vmokIm.get(name);
          getResults[name] = {
            type: typeof mod,
            keys: mod && typeof mod === 'object' ? Object.keys(mod).slice(0, 30) : null,
            value: mod === undefined ? 'undefined' : mod === null ? 'null' : undefined,
          };
        } catch (e) {
          getResults[name] = { error: (e as Error).message };
        }
      }
      out.getAttempts = getResults;
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
