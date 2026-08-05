#!/usr/bin/env tsx
/**
 * 一次性探查 IM SDK 各 manager 方法 -> data/managers-detail.json
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STORAGE_STATE = path.resolve(__dirname, '..', '..', 'ccc', 'data', 'storageState.json');
const OUTPUT_FILE = path.resolve(__dirname, '..', 'data', 'managers-detail.json');

const PROBE_SRC = `
(async () => {
  const out = {};
  const vmokKey = Object.keys(window).find((k) => k.startsWith('__VMOK_@pc-im/im'));
  if (!vmokKey) return { error: 'no vmok' };
  const vmok = window[vmokKey];
  const loader = await vmok.get('.');
  const mod = await loader();
  const instance = mod.Context && mod.Context.instance;
  if (!instance) return { error: 'no instance' };

  const svc = instance.imSdkService;

  function fns(obj, max) {
    if (!obj) return [];
    const out = [];
    for (const k of Object.keys(obj)) {
      try {
        if (typeof obj[k] === 'function') {
          out.push({ name: k, snippet: obj[k].toString().slice(0, 250) });
        }
      } catch {}
      if (out.length >= (max || 100)) break;
    }
    return out;
  }

  out.clm = { keys: Object.keys(svc.conversationListManager || {}), fns: fns(svc.conversationListManager) };
  out.cm  = { keys: Object.keys(svc.conversationManager || {}), fns: fns(svc.conversationManager) };
  out.mlf = { keys: Object.keys(svc.messageListFactoty || {}), fns: fns(svc.messageListFactoty) };
  out.mm  = { keys: Object.keys(svc.messageManager || {}), fns: fns(svc.messageManager) };
  out.smm = { keys: Object.keys(svc.sendMessageManager || {}), fns: fns(svc.sendMessageManager) };
  out.rmm = { keys: Object.keys(svc.receiveMessageManager || {}), fns: fns(svc.receiveMessageManager) };
  out.imSdkInstance = { keys: Object.keys(instance.imSdkInstance || {}), fns: fns(instance.imSdkInstance) };

  // store
  if (instance.store) {
    out.storeKeys = Object.keys(instance.store);
    const cs = instance.store.conversationStore;
    if (cs) {
      out.cs = {
        keys: Object.keys(cs),
        proto: Object.getOwnPropertyNames(Object.getPrototypeOf(cs)),
        conversationMapSize: cs.conversationMap ? cs.conversationMap.size : 0,
        conversationMapKeys: cs.conversationMap ? [...cs.conversationMap.keys()].slice(0, 30) : [],
      };
    }
    const ms = instance.store.messageStore;
    if (ms) {
      out.ms = {
        keys: Object.keys(ms),
        proto: Object.getOwnPropertyNames(Object.getPrototypeOf(ms)),
      };
    }
    const us = instance.store.userStore;
    if (us) {
      out.us = { keys: Object.keys(us), proto: Object.getOwnPropertyNames(Object.getPrototypeOf(us)) };
    }
  }

  return out;
})()
`;

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--window-size=1400,900'],
  });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    storageState: STORAGE_STATE,
  });
  await context.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = window.chrome || { runtime: {} };
  `);
  const page = await context.newPage();
  await page.goto('https://www.douyin.com/chat?isPopup=1', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // 等待页面加载 + SDK 初始化 + 自然触发会话列表拉取
  await page.waitForTimeout(20000);

  const result = await page.evaluate(PROBE_SRC);
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log('保存到:', OUTPUT_FILE);
  console.log('clm fns:', result.clm?.fns?.length || 0);
  console.log('cm fns:', result.cm?.fns?.length || 0);
  console.log('mlf fns:', result.mlf?.fns?.length || 0);
  console.log('conversationMap size:', result.cs?.conversationMapSize);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
