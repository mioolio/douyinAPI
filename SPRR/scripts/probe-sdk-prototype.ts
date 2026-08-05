#!/usr/bin/env tsx
/**
 * 探查 imSdkInstance 原型方法、curMessageListStore、usersInfoStore
 * 这些是发送/拉取消息历史所必需的。
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STORAGE_STATE = path.resolve(__dirname, '..', '..', 'ccc', 'data', 'storageState.json');
const OUTPUT_FILE = path.resolve(__dirname, '..', 'data', 'sdk-prototype-detail.json');

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

  function protoChain(obj, depth) {
    depth = depth || 3;
    const out = [];
    let cur = obj;
    for (let i = 0; i < depth && cur && cur !== Object.prototype; i++) {
      out.push({
        level: i,
        keys: Object.getOwnPropertyNames(cur).filter(k => typeof cur[k] === 'function'),
      });
      cur = Object.getPrototypeOf(cur);
    }
    return out;
  }

  // imSdkInstance 完整原型链
  if (instance.imSdkInstance) {
    out.imSdkInstanceProto = protoChain(instance.imSdkInstance, 5);
    // 重点找含 'Message' 'Conversation' 'Send' 的方法
    const interesting = [];
    let cur = instance.imSdkInstance;
    for (let i = 0; i < 5 && cur && cur !== Object.prototype; i++) {
      for (const k of Object.getOwnPropertyNames(cur)) {
        try {
          if (typeof cur[k] === 'function' && /message|conversation|send|create|get|fetch|history/i.test(k)) {
            interesting.push({ level: i, name: k, snippet: cur[k].toString().slice(0, 300) });
          }
        } catch {}
      }
      cur = Object.getPrototypeOf(cur);
    }
    out.imSdkInstanceInteresting = interesting;
  }

  // store.curMessageListStore 完整结构
  if (instance.store) {
    const cms = instance.store.curMessageListStore;
    if (cms) {
      out.curMessageListStore = {
        keys: Object.keys(cms),
        proto: Object.getOwnPropertyNames(Object.getPrototypeOf(cms)),
        protoChain: protoChain(cms, 3),
      };
      // 看看里面已有什么数据
      for (const k of Object.keys(cms)) {
        try {
          const v = cms[k];
          if (v instanceof Map) {
            out.curMessageListStore[k] = { type: 'Map', size: v.size, keys: [...v.keys()].slice(0, 5) };
          } else if (Array.isArray(v)) {
            out.curMessageListStore[k] = { type: 'Array', length: v.length };
          } else if (typeof v === 'object' && v !== null) {
            out.curMessageListStore[k] = { type: 'object', keys: Object.keys(v).slice(0, 10) };
          } else {
            out.curMessageListStore[k] = { type: typeof v, value: String(v).slice(0, 100) };
          }
        } catch (e) {
          out.curMessageListStore[k] = { error: String(e) };
        }
      }
    }

    const uis = instance.store.usersInfoStore;
    if (uis) {
      out.usersInfoStore = {
        keys: Object.keys(uis),
        proto: Object.getOwnPropertyNames(Object.getPrototypeOf(uis)),
      };
    }

    const sms = instance.store.sendMessageStore;
    if (sms) {
      out.sendMessageStore = {
        keys: Object.keys(sms),
        proto: Object.getOwnPropertyNames(Object.getPrototypeOf(sms)),
      };
    }
  }

  // sendMessageManager 完整原型链
  const smm = instance.imSdkService.sendMessageManager;
  if (smm) {
    out.smmProto = protoChain(smm, 3);
  }

  // createMessageBuilder 返回的 builder 长什么样（不真的发送）
  try {
    const builder = instance.imSdkService.sendMessageManager.createMessageBuilder({
      messageType: 700,
      from: 'test',
      enterMethod: 'test',
    });
    if (builder) {
      out.builderKeys = Object.keys(builder);
      out.builderProto = Object.getOwnPropertyNames(Object.getPrototypeOf(builder));
      // builder 上的链式方法
      const chainMethods = [];
      let cur = builder;
      for (let i = 0; i < 3 && cur && cur !== Object.prototype; i++) {
        for (const k of Object.getOwnPropertyNames(cur)) {
          try {
            if (typeof cur[k] === 'function') {
              chainMethods.push({ level: i, name: k, snippet: cur[k].toString().slice(0, 150) });
            }
          } catch {}
        }
        cur = Object.getPrototypeOf(cur);
      }
      out.builderMethods = chainMethods;
    }
  } catch (e) {
    out.builderError = String(e);
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
  await page.waitForTimeout(20000);

  const result = await page.evaluate(PROBE_SRC);
  await fs.writeFile(OUTPUT_FILE, JSON.stringify(result, null, 2));
  console.log('保存到:', OUTPUT_FILE);
  console.log('imSdkInstance proto levels:', result.imSdkInstanceProto?.length || 0);
  console.log('imSdkInstance interesting methods:', result.imSdkInstanceInteresting?.length || 0);
  console.log('builder methods:', result.builderMethods?.length || 0);
  console.log('curMessageListStore keys:', result.curMessageListStore?.keys?.length || 0);
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
