#!/usr/bin/env tsx
/**
 * 端到端测试：用页面内 fetch 调用发消息 API
 *
 * 原理：
 * 抖音前端注册了 fetch 拦截器（window.fetch 已被改写），
 * 所有走 window.fetch 的请求都会被自动注入：
 * - bd-ticket-guard-* 系列 headers
 * - a_bogus / msToken / verifyFp / fp 等查询参数
 * - cookie 自动携带
 *
 * 所以我们只需要在页面内构造 protobuf body 并 fetch，就能发消息。
 *
 * 本脚本测试：
 * 1. 先调用会话列表 API（POST imapi.douyin.com/v1/stranger/get_conversation_list）
 *    验证 fetch + 签名机制是否工作
 * 2. （可选）调用发消息 API（POST imapi.douyin.com/v1/message/send）
 *    需要构造 protobuf body
 *
 * 用法：npx tsx scripts/test-send-via-page-fetch.ts
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

const OUTPUT_FILE = path.resolve(__dirname, '..', 'data', 'test-page-fetch.json');

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

  // 测试 1：验证 fetch 拦截器工作（不构造 protobuf，直接发一个空 body 看响应）
  // 抖音 API 对空 body 会返回 400 或错误，但能验证签名是否注入
  console.log('\n=== 测试 1：验证 fetch 拦截器注入签名 ===');

  const testResult = await page.evaluate(async () => {
    const results: Record<string, unknown> = {};

    // 1.1 测试会话列表 API（空 body，预期 400 但应能看到签名注入）
    try {
      const url = 'https://imapi.douyin.com/v1/stranger/get_conversation_list';
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-protobuf',
          Accept: 'application/x-protobuf',
        },
        body: new Uint8Array(0),
      });
      results.conversationListApi = {
        status: res.status,
        statusText: res.statusText,
        headers: Object.fromEntries(res.headers.entries()),
      };
      // 不要消费 body（protobuf 二进制不好序列化），只看状态
    } catch (e) {
      results.conversationListApi = { error: (e as Error).message };
    }

    // 1.2 测试发送消息 API（空 body，预期 400 但能看签名）
    try {
      const url = 'https://imapi.douyin.com/v1/message/send';
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-protobuf',
          Accept: 'application/x-protobuf',
        },
        body: new Uint8Array(0),
      });
      results.sendMsgApi = {
        status: res.status,
        statusText: res.statusText,
        headers: Object.fromEntries(res.headers.entries()),
      };
    } catch (e) {
      results.sendMsgApi = { error: (e as Error).message };
    }

    // 1.3 检查 fetch 拦截器是否真的注入了签名
    // 通过拦截原始 fetch 看实际发送的 URL 和 headers
    const originalFetch = window.fetch;
    let capturedRequest: { url: string; headers: Record<string, string> } | null = null;
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers: Record<string, string> = {};
      if (init?.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((v, k) => (headers[k] = v));
        } else if (Array.isArray(init.headers)) {
          for (const [k, v] of init.headers) headers[k] = v;
        } else {
          Object.assign(headers, init.headers);
        }
      }
      capturedRequest = { url, headers };
      // 调用原始 fetch（即被抖音改写过的 fetch）
      return originalFetch.call(this, input, init);
    } as typeof fetch;

    try {
      await fetch('https://imapi.douyin.com/v1/stranger/get_conversation_list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-protobuf' },
        body: new Uint8Array(0),
      }).catch(() => {});
      results.capturedRequest = capturedRequest;
    } catch (e) {
      results.capturedRequest = { error: (e as Error).message };
    } finally {
      // 恢复
      window.fetch = originalFetch;
    }

    return results;
  });

  console.log('测试结果:');
  console.log(JSON.stringify(testResult, null, 2));

  await fs.writeFile(OUTPUT_FILE, JSON.stringify(testResult, null, 2));
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
