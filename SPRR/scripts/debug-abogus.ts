/**
 * a_bogus 中间变量拦截调试脚本
 *
 * 流程：
 *   1. 启动有头浏览器，加载已登录 storageState
 *   2. 访问抖音页面，等待 bdms.js 加载完成
 *   3. 在浏览器内 hijack XMLHttpRequest / fetch，捕获抖音前端生成的真实 a_bogus
 *   4. 同时用我们的 abogus.ts 生成 a_bogus（输入相同参数）
 *   5. 对比两者的中间变量：
 *      - urlParams 字符串
 *      - body 字符串
 *      - SM3 哈希结果
 *      - 时间戳字节
 *      - payload 字节
 *      - rc4 加密结果
 *      - 最终 a_bogus 字符串
 *
 * 用法：npx tsx scripts/debug-abogus.ts
 */
import { chromium } from 'playwright';
import { resolveStorageState } from '../src/auth/accounts.js';
import { generateABogus, sm3 } from '../src/crypto/abogus.js';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('debug-abogus');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const WEB_PARAMS: Record<string, string> = {
  device_platform: 'webapp',
  aid: '6383',
  channel: 'channel_pc_web',
  update_version_code: '170400',
  pc_client_type: '1',
  pc_libra_divert: 'Windows',
  support_h265: '1',
  support_dash: '0',
  cpu_core_num: '12',
  version_code: '170400',
  version_name: '17.4.0',
  cookie_enabled: 'true',
  screen_width: '1400',
  screen_height: '900',
  browser_language: 'zh-CN',
  browser_platform: 'Win32',
  browser_name: 'Chrome',
  browser_version: '130.0.0.0',
  browser_online: 'true',
  engine_name: 'Blink',
  engine_version: '130.0.0.0',
  os_name: 'Windows',
  os_version: '10',
  device_memory: '16',
  platform: 'PC',
  downlink: '10',
  effective_type: '4g',
  round_trip_time: '150',
};

/** 在 Node.js 端复现 a_bogus 生成并输出所有中间变量 */
function generateWithDebug(input: {
  url: string;
  params: Record<string, string>;
  method: 'GET' | 'POST';
  userAgent: string;
  body?: string;
}) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(input.params)) usp.append(k, v);
  const urlParams = usp.toString();
  const bodyStr = input.method === 'POST' && input.body != null ? input.body : '';

  // SM3 双重哈希
  const urlHash1 = sm3(new TextEncoder().encode(urlParams + 'dhzx'));
  const urlHash = sm3(urlHash1);
  const bodyHash1 = sm3(new TextEncoder().encode(bodyStr + 'dhzx'));
  const bodyHash = sm3(bodyHash1);

  // UA 哈希
  const S3_TABLE = 'ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe';
  const uaB64 = customBase64Encode(new TextEncoder().encode(input.userAgent), S3_TABLE);
  const uaHash = sm3(new TextEncoder().encode(uaB64));

  // 最终 a_bogus
  const aBogus = generateABogus({
    url: input.url,
    params: input.params,
    method: input.method,
    userAgent: input.userAgent,
    body: input.body,
  });

  return {
    urlParams,
    bodyStr,
    urlHash_hex: toHex(urlHash),
    bodyHash_hex: toHex(bodyHash),
    uaB64,
    uaHash_hex: toHex(uaHash),
    aBogus,
    aBogus_len: aBogus.length,
    // 关键字节
    urlHashBytes: {
      [9]: urlHash[9],
      [18]: urlHash[18],
      [3]: urlHash[3],
    },
    bodyHashBytes: {
      [10]: bodyHash[10],
      [19]: bodyHash[19],
      [4]: bodyHash[4],
    },
    uaHashBytes: {
      [11]: uaHash[11],
      [21]: uaHash[21],
      [5]: uaHash[5],
    },
  };
}

function toHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function customBase64Encode(data: Uint8Array, table: string): string {
  let out = '';
  const len = data.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = data[i];
    const b1 = i + 1 < len ? data[i + 1] : 0;
    const b2 = i + 2 < len ? data[i + 2] : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += table[(triple >> 18) & 0x3f];
    out += table[(triple >> 12) & 0x3f];
    if (i + 1 < len) out += table[(triple >> 6) & 0x3f];
    if (i + 2 < len) out += table[triple & 0x3f];
  }
  return out;
}

async function main() {
  const { path: statePath } = await resolveStorageState(undefined, undefined);
  log.info(`使用 storageState: ${statePath}`);

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
  });
  const context = await browser.newContext({
    storageState: statePath,
    userAgent: DEFAULT_UA,
    viewport: { width: 1400, height: 900 },
    locale: 'zh-CN',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();

  // 拦截网络请求，捕获抖音生成的 a_bogus
  const capturedBogus: Array<{
    url: string;
    method: string;
    a_bogus: string;
    body: string;
    params: Record<string, string>;
  }> = [];

  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('a_bogus=')) return;
    const u = new URL(url);
    const aBogusValue = u.searchParams.get('a_bogus');
    if (!aBogusValue) return;
    const params: Record<string, string> = {};
    for (const [k, v] of u.searchParams.entries()) {
      if (k !== 'a_bogus') params[k] = v;
    }
    capturedBogus.push({
      url: u.pathname,
      method: req.method(),
      a_bogus: aBogusValue,
      body: req.postData() || '',
      params,
    });
    log.info(`\n[捕获] ${req.method()} ${u.pathname}`);
    log.info(`  a_bogus (浏览器生成, len=${aBogusValue.length}): ${aBogusValue}`);
  });

  log.info('访问抖音主页，等待 bdms.js 加载...');
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForTimeout(8000);

  // 从浏览器提取实际设备属性值（与 bdms Z-table 的 11 个字段对应）
  log.info('\n=== 浏览器实际设备属性 ===');
  const deviceProps = await page.evaluate(() => {
    const screen = (window as unknown as { screen: Record<string, unknown> }).screen || {};
    const nav = navigator as unknown as Record<string, unknown>;
    const docEl = document.documentElement;
    return {
      // Z-table 顺序：innerWidth, innerHeight, outerWidth, outerHeight,
      //              availWidth, availHeight, width, sizeWidth, height, sizeHeight, platform
      innerWidth: (window as unknown as { innerWidth: number }).innerWidth,
      innerHeight: (window as unknown as { innerHeight: number }).innerHeight,
      outerWidth: (window as unknown as { outerWidth: number }).outerWidth,
      outerHeight: (window as unknown as { outerHeight: number }).outerHeight,
      availWidth: (screen as { availWidth?: number }).availWidth,
      availHeight: (screen as { availHeight?: number }).availHeight,
      width: (screen as { width?: number }).width,
      height: (screen as { height?: number }).height,
      // sizeWidth / sizeHeight 不是标准 API，探测多个可能来源
      sizeWidth_screen: (screen as { sizeWidth?: number }).sizeWidth,
      sizeHeight_screen: (screen as { sizeHeight?: number }).sizeHeight,
      sizeWidth_window: (window as unknown as { sizeWidth?: number }).sizeWidth,
      sizeHeight_window: (window as unknown as { sizeHeight?: number }).sizeHeight,
      clientWidth_docEl: docEl?.clientWidth,
      clientHeight_docEl: docEl?.clientHeight,
      clientWidth_body: document.body?.clientWidth,
      clientHeight_body: document.body?.clientHeight,
      platform: nav.platform,
      colorDepth: (screen as { colorDepth?: number }).colorDepth,
      pixelDepth: (screen as { pixelDepth?: number }).pixelDepth,
      devicePixelRatio: (window as unknown as { devicePixelRatio: number }).devicePixelRatio,
    };
  });
  log.info(`浏览器设备属性: ${JSON.stringify(deviceProps, null, 2)}`);

  // 触发一些 API 调用（访问个人主页会自动调用 profile/self）
  log.info('\n=== 触发 profile/self API 调用 ===');
  await page.goto('https://www.douyin.com/user/self?from_tab_name=main&showTab=post', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  }).catch((e: unknown) => log.warn(`导航失败（可忽略）: ${(e as Error).message}`));
  await page.waitForTimeout(8000);

  // 等待捕获
  await page.waitForTimeout(3000);

  // 在关闭浏览器前输出对比结果（确保即使后续出错也能看到）
  if (capturedBogus.length === 0) {
    log.error('未捕获到任何 a_bogus 请求（可能 cookie 失效或 bdms 未加载）');
    await browser.close();
    process.exit(1);
  }

  // 选第一个捕获的请求做对比
  const captured = capturedBogus[0];
  log.info(`\n\n========== 对比第 1 个捕获请求 ==========`);
  log.info(`URL: ${captured.url}`);
  log.info(`Method: ${captured.method}`);
  log.info(`Body: "${captured.body}"`);

  // 用相同参数在 Node.js 端生成
  const ourResult = generateWithDebug({
    url: captured.url,
    params: captured.params,
    method: captured.method as 'GET' | 'POST',
    userAgent: DEFAULT_UA,
    body: captured.body || undefined,
  });

  log.info(`\n--- Node.js 端中间变量 ---`);
  log.info(`urlParams: ${ourResult.urlParams}`);
  log.info(`bodyStr: "${ourResult.bodyStr}"`);
  log.info(`urlHash: ${ourResult.urlHash_hex}`);
  log.info(`bodyHash: ${ourResult.bodyHash_hex}`);
  log.info(`uaB64: ${ourResult.uaB64}`);
  log.info(`uaHash: ${ourResult.uaHash_hex}`);
  log.info(`urlHash bytes [9,18,3]: ${ourResult.urlHashBytes[9]}, ${ourResult.urlHashBytes[18]}, ${ourResult.urlHashBytes[3]}`);
  log.info(`bodyHash bytes [10,19,4]: ${ourResult.bodyHashBytes[10]}, ${ourResult.bodyHashBytes[19]}, ${ourResult.bodyHashBytes[4]}`);
  log.info(`uaHash bytes [11,21,5]: ${ourResult.uaHashBytes[11]}, ${ourResult.uaHashBytes[21]}, ${ourResult.uaHashBytes[5]}`);
  log.info(`\n我们的 a_bogus (len=${ourResult.aBogus_len}): ${ourResult.aBogus}`);
  log.info(`浏览器 a_bogus (len=${captured.a_bogus.length}): ${captured.a_bogus}`);

  await browser.close();

  // 字节级对比
  log.info(`\n--- 字节级对比 ---`);
  const ourHex = Buffer.from(ourResult.aBogus, 'utf-8').toString('hex');
  const browserHex = Buffer.from(captured.a_bogus, 'utf-8').toString('hex');
  log.info(`我们 (hex): ${ourHex}`);
  log.info(`浏览器(hex): ${browserHex}`);

  // 找出第一个不同的字符位置
  const minLen = Math.min(ourResult.aBogus.length, captured.a_bogus.length);
  let firstDiff = -1;
  for (let i = 0; i < minLen; i++) {
    if (ourResult.aBogus[i] !== captured.a_bogus[i]) {
      firstDiff = i;
      break;
    }
  }
  if (firstDiff === -1) {
    if (ourResult.aBogus.length === captured.a_bogus.length) {
      log.info('✓ 完全一致！');
    } else {
      log.warn(`长度不同: 我们=${ourResult.aBogus.length} 浏览器=${captured.a_bogus.length}`);
    }
  } else {
    log.error(`✗ 第 ${firstDiff} 位开始不同`);
    log.error(`  我们:   ...${ourResult.aBogus.slice(Math.max(0, firstDiff - 5), firstDiff + 10)}...`);
    log.error(`  浏览器: ...${captured.a_bogus.slice(Math.max(0, firstDiff - 5), firstDiff + 10)}...`);
  }
}

main().catch((e) => {
  log.error('调试失败', e);
  process.exit(1);
});
