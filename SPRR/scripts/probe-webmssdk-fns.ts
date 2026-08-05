/**
 * 全面探索 webmssdk 暴露的方法，找到生成 a_bogus 的函数
 *
 * 策略：
 *   1. 列出 byted_acrawler 和 window 上的所有相关属性
 *   2. 手动调用 frontierSign 之外的方法，看哪个返回 a_bogus 格式
 *   3. 通过给定的 input，调用各方法，记录返回字符串长度
 *   4. 找到生成 188 字符 (新版) 或 162 字符 (旧版) 字符串的函数
 */
import { chromium } from 'playwright';
import { resolveStorageState } from '../src/auth/accounts.js';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('probe-webmssdk-fns');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

async function main() {
  const { path: statePath } = await resolveStorageState(undefined, undefined);
  log.info(`storageState: ${statePath}`);

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  const context = await browser.newContext({
    storageState: statePath,
    userAgent: DEFAULT_UA,
    viewport: { width: 1400, height: 900 },
    locale: 'zh-CN',
  });

  const page = await context.newPage();
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.startsWith('[PROBE]')) log.info(`[browser] ${text}`);
  });

  // 先 hook XHR.send，捕获 a_bogus 的最终输出
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    const w = window as unknown as Record<string, unknown>;
    (w.__abogusCaptures as unknown[]) = [];

    // Hook XHR open
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method: string, url: string) {
      if (typeof url === 'string' && url.includes('aweme')) {
        (w.__abogusCaptures as unknown[]).push({ phase: 'open', method, url: url.substring(0, 400), ts: Date.now() });
      }
      return origOpen.apply(this, [method, url] as Parameters<typeof origOpen>);
    };

    // Hook XHR send
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body: Document | XMLHttpRequestBodyInit | null | undefined) {
      const url = this._url || (this as unknown as { responseURL?: string }).responseURL;
      if (typeof url === 'string' && url.includes('aweme')) {
        (w.__abogusCaptures as unknown[]).push({ phase: 'send', url: url.substring(0, 400), ts: Date.now() });
      }
      return origSend.apply(this, [body] as Parameters<typeof origSend>);
    };
  });

  log.info('访问抖音主页加载 webmssdk...');
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(8000);

  // 1. 列出 byted_acrawler 的所有方法和 window 上所有与 byted/webms/sdk 相关的属性
  const exploreResult = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    // byted_acrawler
    const ac = w.byted_acrawler as Record<string, unknown> | undefined;
    if (ac) {
      out.byted_acrawler = {
        exists: true,
        keys: Object.keys(ac),
        methods: Object.keys(ac).filter((k) => typeof ac[k] === 'function'),
      };
    } else {
      out.byted_acrawler = { exists: false };
    }

    // 找其他可能的 a_bogus 生成函数
    const candidateKeys = Object.keys(w).filter(
      (k) =>
        /byted|acrawl|webms|sdk|sign|bogus|abyss|abog/i.test(k) ||
        k.startsWith('bd_') ||
        k.startsWith('_bd') ||
        k.startsWith('__bd')
    );
    out.candidateKeys = candidateKeys.map((k) => ({ key: k, type: typeof w[k] }));

    // 详细看每个 candidate
    const details: Record<string, unknown> = {};
    for (const k of candidateKeys) {
      const v = w[k];
      if (typeof v === 'function') {
        details[k] = { type: 'function', length: (v as { length?: number }).length, toString: (v as { toString: () => string }).toString().substring(0, 200) };
      } else if (typeof v === 'object' && v !== null) {
        const obj = v as Record<string, unknown>;
        details[k] = { type: 'object', keys: Object.keys(obj).slice(0, 30), methods: Object.keys(obj).filter((kk) => typeof obj[kk] === 'function') };
      } else {
        details[k] = { type: typeof v, value: String(v).substring(0, 100) };
      }
    }
    out.details = details;

    return out;
  });

  log.info('\n=== webmssdk 暴露的对象 ===');
  log.info(`byted_acrawler 存在: ${(exploreResult.byted_acrawler as { exists: boolean }).exists}`);
  if ((exploreResult.byted_acrawler as { exists: boolean }).exists) {
    log.info(`  方法: ${(exploreResult.byted_acrawler as { methods: string[] }).methods.join(', ')}`);
  }
  log.info(`候选 keys: ${(exploreResult.candidateKeys as Array<{ key: string; type: string }>).map((c) => c.key + ':' + c.type).join(', ')}`);

  // 详细列出 byted_acrawler 之外的对象
  const details = exploreResult.details as Record<string, { type: string; keys?: string[]; methods?: string[]; toString?: string }>;
  for (const [k, v] of Object.entries(details)) {
    if (k === 'byted_acrawler') continue;
    if (v.type === 'object' && v.methods) {
      log.info(`  ${k}.methods: ${v.methods.join(', ')}`);
    } else if (v.type === 'function') {
      log.info(`  ${k}: function (len=${(v as unknown as { length?: number }).length || '?'})`);
    } else {
      log.info(`  ${k}: ${v.type}`);
    }
  }

  // 2. 列出 byted_acrawler 内部方法的具体形态
  const bytedMethods = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const ac = w.byted_acrawler as Record<string, unknown> | undefined;
    if (!ac) return [];
    return Object.keys(ac).map((k) => {
      const v = ac[k];
      return {
        key: k,
        type: typeof v,
        isFunction: typeof v === 'function',
        length: typeof v === 'function' ? (v as { length: number }).length : 0,
        toString: typeof v === 'function' ? v.toString().substring(0, 300) : '',
      };
    });
  });
  log.info(`\n=== byted_acrawler 完整方法 (${bytedMethods.length}) ===`);
  for (const m of bytedMethods) {
    if (m.isFunction) {
      log.info(`  ${m.key} (fn, args=${m.length}): ${m.toString.substring(0, 200)}`);
    }
  }

  // 3. 尝试调用每个方法看返回值
  const testInput = {
    url: '/aweme/v1/web/im/resource/sticker/collect/',
    params: {
      device_platform: 'webapp',
      aid: '6383',
      app_id: '1128',
      channel: 'channel_pc_web',
      sec_user_id: 'MS4wLjABAAAA',
      sticker_id: 'test_id',
      sticker_type: '1',
      action: '1',
    },
    method: 'POST',
    body: '{}',
  };

  const methodResults = await page.evaluate((input) => {
    const w = window as unknown as Record<string, unknown>;
    const ac = w.byted_acrawler as Record<string, unknown> | undefined;
    if (!ac) return [];
    const results: Array<{ key: string; ok: boolean; result: string; type: string; err?: string }> = [];
    for (const key of Object.keys(ac)) {
      const fn = ac[key];
      if (typeof fn !== 'function') continue;
      // 跳过明显非签名的方法
      if (['init', 'setConfig', 'getReferer', 'getConfig'].includes(key)) continue;
      try {
        const r = (fn as (...a: unknown[]) => unknown).call(ac, input);
        const t = typeof r;
        let v = '';
        if (typeof r === 'string') v = r;
        else if (r && typeof r === 'object') {
          try {
            v = JSON.stringify(r).substring(0, 200);
          } catch {
            v = '[object]';
          }
        } else v = String(r);
        results.push({ key, ok: true, result: v, type: t });
      } catch (e) {
        results.push({ key, ok: false, result: '', type: 'error', err: (e as Error).message.substring(0, 100) });
      }
    }
    return results;
  }, testInput);

  log.info(`\n=== 调用 byted_acrawler 各方法 (${methodResults.length}) ===`);
  for (const r of methodResults) {
    if (r.ok && r.result && r.result.length > 5) {
      log.info(`  ${r.key}: type=${r.type}, len=${r.result.length}, value=${r.result.substring(0, 150)}`);
    } else if (!r.ok) {
      log.info(`  ${r.key}: ERROR ${r.err}`);
    } else {
      log.info(`  ${r.key}: ${r.type} (empty)`);
    }
  }

  // 4. 触发真实业务
  log.info(`\n=== 触发真实业务 (导航到 follow 页面) ===`);
  await page.goto('https://www.douyin.com/follow', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(10000);

  const captures = await page.evaluate(() => (window as unknown as { __abogusCaptures: unknown[] }).__abogusCaptures);
  log.info(`XHR 触发次数: ${(captures as unknown[]).length}`);

  await browser.close();
}

main().catch((e) => {
  log.error('失败', e);
  process.exit(1);
});
