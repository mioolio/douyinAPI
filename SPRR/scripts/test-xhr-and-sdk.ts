#!/usr/bin/env tsx
/**
 * 端到端测试 v2：用 XMLHttpRequest 调用发消息 API
 *
 * 上一版用 fetch 失败（Failed to fetch），可能是 CORS 或拦截器只挂 XHR。
 * 本版改用 XMLHttpRequest，并对比 fetch 和 XHR 两种方式。
 *
 * 同时探查：
 * - window.__VMOK__ 模块联邦是否能拿到 IM SDK 实例
 * - 拦截 XMLHttpRequest.prototype.open/send 看实际 URL 和 headers
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

const OUTPUT_FILE = path.resolve(__dirname, '..', 'data', 'test-xhr-and-sdk.json');

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

  console.log('等待 15s 让页面 SDK 加载完整...');
  await page.waitForTimeout(15000);

  // 拦截网络请求，看真实请求是怎样的（用 Playwright route 比改写 fetch 更底层）
  console.log('\n=== 设置网络拦截器（只观察不修改）===');
  const capturedRequests: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    postDataLength: number;
  }> = [];

  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('imapi.douyin.com') || url.includes('/v1/message/send') || url.includes('/v1/stranger/')) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers())) {
        headers[k] = v;
      }
      capturedRequests.push({
        url,
        method: req.method(),
        headers,
        postDataLength: req.postData()?.length ?? 0,
      });
    }
  });

  // 测试 1：用 XMLHttpRequest 调用 API（让抖音的 XHR 拦截器处理签名）
  console.log('\n=== 测试 1：XMLHttpRequest 调用会话列表 API ===');

  const testResult = await page.evaluate(async () => {
    const results: Record<string, unknown> = {};

    // 1.1 用 XHR 调用会话列表 API
    const xhrResult = await new Promise<{ status: number; statusText: string; headers: string }>(
      (resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', 'https://imapi.douyin.com/v1/stranger/get_conversation_list');
        xhr.setRequestHeader('Content-Type', 'application/x-protobuf');
        xhr.setRequestHeader('Accept', 'application/x-protobuf');
        xhr.responseType = 'arraybuffer';
        xhr.onload = () => {
          resolve({
            status: xhr.status,
            statusText: xhr.statusText,
            headers: xhr.getAllResponseHeaders(),
          });
        };
        xhr.onerror = () => resolve({ status: 0, statusText: 'XHR error', headers: '' });
        xhr.ontimeout = () => resolve({ status: 0, statusText: 'XHR timeout', headers: '' });
        xhr.timeout = 10000;
        xhr.send(new Uint8Array(0));
      },
    );
    results.xhrCall = xhrResult;

    // 1.2 用 fetch with credentials
    try {
      const res = await fetch('https://imapi.douyin.com/v1/stranger/get_conversation_list', {
        method: 'POST',
        credentials: 'include',
        mode: 'cors',
        headers: {
          'Content-Type': 'application/x-protobuf',
          Accept: 'application/x-protobuf',
        },
        body: new Uint8Array(0),
      });
      results.fetchCors = {
        status: res.status,
        statusText: res.statusText,
      };
    } catch (e) {
      results.fetchCors = { error: (e as Error).message };
    }

    // 1.3 探查 VMOK 模块联邦
    try {
      const vmok = (window as unknown as Record<string, unknown>).__VMOK__;
      const vmokIm = (window as unknown as Record<string, unknown>)['__VMOK_@pc-im/im:1.0.0.696__'];
      results.vmok = {
        exists: !!vmok,
        keys: vmok && typeof vmok === 'object' ? Object.keys(vmok).slice(0, 20) : [],
      };
      results.vmokIm = {
        exists: !!vmokIm,
        keys: vmokIm && typeof vmokIm === 'object' ? Object.keys(vmokIm).slice(0, 20) : [],
      };

      // 尝试调用 vmok.get 拿到 IM SDK 实例
      if (vmok && typeof vmok === 'object') {
        const vmokObj = vmok as { get?: Function; load?: Function; require?: Function };
        try {
          if (typeof vmokObj.get === 'function') {
            const imMod = await vmokObj.get('@pc-im/im');
            results.vmokGetResult = {
              type: typeof imMod,
              keys: imMod && typeof imMod === 'object' ? Object.keys(imMod).slice(0, 30) : [],
            };
          }
        } catch (e) {
          results.vmokGetError = (e as Error).message;
        }
        try {
          if (typeof vmokObj.load === 'function') {
            const imMod2 = await vmokObj.load('@pc-im/im');
            results.vmokLoadResult = {
              type: typeof imMod2,
              keys: imMod2 && typeof imMod2 === 'object' ? Object.keys(imMod2).slice(0, 30) : [],
            };
          }
        } catch (e) {
          results.vmokLoadError = (e as Error).message;
        }
      }
    } catch (e) {
      results.vmokError = (e as Error).message;
    }

    // 1.4 探查 __GLOBAL_LOADING_REMOTE_ENTRY__
    try {
      const gle = (window as unknown as Record<string, unknown>).__GLOBAL_LOADING_REMOTE_ENTRY__;
      results.globalLoadingRemoteEntry = gle;
    } catch (e) {
      results.globalLoadingRemoteEntryError = (e as Error).message;
    }

    return results;
  });

  console.log('\n测试结果:');
  console.log(JSON.stringify(testResult, null, 2));
  console.log('\n捕获的 imapi 请求:');
  console.log(JSON.stringify(capturedRequests, null, 2));

  await fs.writeFile(
    OUTPUT_FILE,
    JSON.stringify({ testResult, capturedRequests }, null, 2),
  );
  console.log(`\n详细结果已保存: ${OUTPUT_FILE}`);

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
