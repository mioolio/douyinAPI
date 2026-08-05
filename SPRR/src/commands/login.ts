/**
 * 浏览器扫码登录并保存 storageState
 *
 * 流程：
 *   1. 启动 headful 浏览器
 *   2. 若已有同名账号则加载旧 storageState（保留上次登录态，可能直接是已登录状态）
 *   3. 打开抖音聊天页，等待用户扫码登录
 *   4. 监测 URL 出现 chat 页 + 关键 cookie（sessionid）出现即视为登录成功
 *   5. 导出 storageState 保存到 data/accounts/<name>.json
 *   6. 自动设置为当前账号
 *
 * 用法：
 *   npx tsx src/commands/login.ts <name>
 *   sprr login <name>
 */

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { accountFile, saveAccountStorageState, setCurrentAccount } from '../auth/accounts.js';
import { createLogger } from '../utils/logger.js';
import { extractTicketGuardFromPage } from './ticket-guard-auto.js';
import { saveTicketGuard } from '../crypto/ticket-guard.js';
import { IMAPI_CONSTANTS, buildRequest, sendImapi, type RequestEnv } from '../api/imapi.js';
import { encodeVarintField, encodeBytesField } from '../crypto/protobuf.js';

const log = createLogger('login');

/** 检查 storageState 中是否包含 sessionid cookie（判断登录态） */
function hasSessionid(state: { cookies?: Array<{ name: string; value: string }> }): boolean {
  return Boolean(state.cookies?.some((c) => c.name === 'sessionid' && c.value));
}

/**
 * 启动浏览器扫码登录并保存为指定账号
 *
 * 默认行为（不加 --oc）：如果已有账号且 storageState 中有 sessionid，则沿用上次登录态，
 * 只用 headless 浏览器访问抖音主页验证 cookie 是否仍然有效，有效则直接复用，无效才提示扫码。
 * 加 --oc（overwrite cookie）：强制打开有头浏览器要求用户重新扫码登录。
 *
 * @param name 账号名
 * @param options.headless 是否无头模式（默认 false，登录必须 headful）
 * @param options.timeout 登录超时（毫秒，默认 5 分钟）
 * @param options.url 登录页 URL（默认 https://www.douyin.com/，特殊账号如火山版可指定 https://creator.douyin.com/）
 * @param options.oc 强制重新扫码登录（覆盖 cookie），默认 false（沿用上次登录态）
 */
export async function loginAccount(
  name: string,
  options: { headless?: boolean; timeout?: number; url?: string; oc?: boolean } = {},
): Promise<void> {
  const headless = options.headless ?? false;
  const timeout = options.timeout ?? 5 * 60 * 1000;
  const loginUrl = options.url ?? 'https://www.douyin.com/';
  const forceReLogin = options.oc ?? false;

  log.info(`启动浏览器登录账号: ${name}（登录页: ${loginUrl}${forceReLogin ? '，强制重新扫码' : ''}）`);
  if (headless) {
    log.warn('headless 模式下无法扫码，仅用于复用已有 storageState 测试');
  }

  // 已有同名账号：加载旧 storageState 作为初始状态
  let existingState: string | undefined;
  let initialSessionids: Set<string> = new Set();
  let oldStateObj: { cookies?: Array<{ name: string; value: string }> } | null = null;
  try {
    await fs.access(accountFile(name));
    existingState = accountFile(name);
    log.info(`检测到已有账号 ${name}，加载旧 storageState（如果是已登录状态可直接使用）`);
    try {
      oldStateObj = JSON.parse(await fs.readFile(accountFile(name), 'utf-8'));
      initialSessionids = new Set(
        (oldStateObj.cookies || [])
          .filter((c) => c.name === 'sessionid' || c.name === 'sessionid_ss')
          .map((c) => c.value),
      );
    } catch {
      // 解析失败忽略
    }
  } catch {
    // 无旧账号
  }

  // 默认模式：已有 sessionid 且未指定 --oc，先用 headless 验证 cookie 有效性
  if (!forceReLogin && existingState && oldStateObj && hasSessionid(oldStateObj)) {
    log.info('检测到旧 sessionid，未指定 --oc，先用无头浏览器验证登录态是否有效...');
    try {
      const result = await verifySessionidValid(existingState, loginUrl);
      if (result.valid) {
        log.info('✓ 上次登录态仍然有效，直接复用（无需扫码）');
        // 保存验证浏览器刷新后的 storageState（包含服务器 set-cookie 的新 token）
        // 注意：不能用 oldStateObj，因为验证过程中服务器可能旋转了 sessionid，
        // 旧 sessionid 已作废，必须保存浏览器 context 中的新 cookie
        const stateToSave = result.freshState || oldStateObj;
        await saveAccountStorageState(name, stateToSave);
        await setCurrentAccount(name);
        const cookieCount = stateToSave.cookies?.length || 0;
        const uid = stateToSave.cookies?.find((c) => c.name === 'uid_tt')?.value;
        log.info(
          `登录完成：账号 ${name}，共 ${cookieCount} 个 cookie，uid_tt=${uid || '?'}`,
        );
        log.info(`已自动设为当前账号，可直接使用 sprr list / sprr history 等命令`);
        log.info(`如需强制重新扫码，使用: login ${name} --oc`);
        return;
      } else {
        log.warn('✗ 上次登录态已失效，需要重新扫码登录');
      }
    } catch (e) {
      log.warn(`验证登录态异常: ${e}，继续走扫码流程`);
    }
  }

  // 打开有头浏览器扫码登录
  const browser = await chromium.launch({
    headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-popup-blocking',
      '--window-size=1400,900',
    ],
  });
  const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  // 统一 context 配置：viewport=null 让页面视口跟随窗口大小（全屏化时内容自动适应）
  const contextOpts: any = {
    userAgent: DEFAULT_UA,
    viewport: null,
    screen: { width: 1920, height: 1080 },
    locale: 'zh-CN',
  };
  if (existingState) contextOpts.storageState = existingState;
  const context = await browser.newContext(contextOpts);

  // 注入 webdriver 隐藏脚本（用字符串形式，避免 tsx 编译时注入 __name 辅助函数导致 ReferenceError）
  await context.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  `);

  const page = await context.newPage();

  // 访问指定登录页（默认抖音主页；特殊账号如火山版需指定 https://creator.douyin.com/）
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // 等待页面稳定（避免风控立即重定向）
  await page.waitForTimeout(3000);

  log.info('请在打开的浏览器中扫码登录抖音（如已登录会自动跳过）...');
  log.info(`等待登录完成（超时 ${Math.floor(timeout / 1000)} 秒）`);

  // 轮询检测登录态：URL 在 chat 页 + sessionid cookie 出现
  // 关键：必须等**新** sessionid 出现（不是旧 storageState 已有的）。
  // 否则复用旧账号时会立即误判为登录成功，导致 server 端不认账。
  const startTime = Date.now();
  let loggedIn = false;
  while (Date.now() - startTime < timeout) {
    await page.waitForTimeout(2000);
    try {
      const state = await context.storageState();
      const currentSessionids = (state.cookies || [])
        .filter((c) => c.name === 'sessionid' || c.name === 'sessionid_ss')
        .map((c) => c.value);
      // 必须存在至少一个**新** sessionid（不在初始集合中）
      const hasNewSessionid = currentSessionids.some((v) => v && !initialSessionids.has(v));
      if (hasSessionid(state) && hasNewSessionid) {
        // 进一步确认 URL 在 douyin.com 域下（避免登录跳转中途保存）
        const url = page.url();
        if (url.includes('douyin.com')) {
          loggedIn = true;
          log.info('检测到新 sessionid，登录成功！');
          // 等待 2 秒让页面其他 cookie（msToken 等）写入
          await page.waitForTimeout(2000);
          break;
        }
      } else if (hasSessionid(state) && initialSessionids.size > 0) {
        // 仅在有旧账号场景下提示一次，避免每个 2s 都打
        if (Date.now() - startTime < 5_000) {
          log.info('检测到旧 storageState 中残留的 sessionid，等待用户扫码后写入新 sessionid...');
        }
      }
    } catch {
      // 忽略
    }
  }

  if (!loggedIn) {
    await browser.close();
    throw new Error('登录超时，未检测到 sessionid cookie');
  }

  // 导出最终 storageState（在关闭浏览器前保存，确保 cookie 完整）
  const finalState = await context.storageState();

  // 复用当前浏览器会话自动获取 ticket-guard 三头（评论发布必需）
  // 浏览器已打开且有登录态，导航到视频页触发 secsdk 初始化即可
  try {
    log.info('登录成功，正在自动获取 ticket-guard 三头（评论发布必需，约 10 秒）...');
    const tgConfig = await extractTicketGuardFromPage(page);
    if (tgConfig) {
      await saveTicketGuard(tgConfig);
      log.info(
        `ticket-guard 三头已自动获取并保存（clientData=${tgConfig.clientData.length}chars, dtrait=${tgConfig.sessionDtrait.length}chars）`,
      );
      log.info('评论功能已就绪，可直接使用 sprr comment 命令');
    } else {
      log.warn('ticket-guard 自动获取失败，评论功能暂不可用');
      log.warn('可手动运行 `sprr ticket-guard --auto` 重新获取（无需重新登录）');
    }
  } catch (e) {
    log.warn('ticket-guard 自动获取异常（不影响登录结果）:', e);
    log.warn('可手动运行 `sprr ticket-guard --auto` 重新获取');
  }

  await browser.close();

  await saveAccountStorageState(name, finalState);

  // 自动设为当前账号
  await setCurrentAccount(name);

  const cookieCount = finalState.cookies?.length || 0;
  const uid = finalState.cookies?.find((c) => c.name === 'uid_tt')?.value;
  log.info(
    `登录完成：账号 ${name}，共 ${cookieCount} 个 cookie，uid_tt=${uid || '?'}`,
  );
  log.info(`已自动设为当前账号，可直接使用 sprr list / sprr history 等命令`);
}

/**
 * 用 headless 浏览器访问抖音主页，验证 storageState 中的 sessionid 是否仍然有效
 *
 * 判定逻辑：访问 https://www.douyin.com/ 后，
 *   - 如果 URL 未被重定向到登录页（login.douyin.com）且页面能正常加载
 *   - 且 cookie 中仍保留 sessionid（未被服务器清除）
 * 则认为登录态有效。
 *
 * @param storageStatePath storageState 文件路径
 * @param loginUrl 登录页 URL（用于火山版等特殊场景）
 * @returns { valid: boolean, freshState?: storageState } 验证结果及刷新后的 storageState
 */
async function verifySessionidValid(
  storageStatePath: string,
  loginUrl: string,
): Promise<{ valid: boolean; freshState?: any }> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  try {
    const context = await browser.newContext({
      storageState: storageStatePath,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      viewport: { width: 1400, height: 900 },
      locale: 'zh-CN',
    });
    // verifySessionidValid 用 headless，无需 viewport=null（不可见）
    const page = await context.newPage();
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // 等待页面稳定
    await page.waitForTimeout(3000);

    const url = page.url();
    log.debug(`[验证] 当前 URL: ${url}`);

    // 被重定向到登录页 → 无效
    if (url.includes('login.douyin.com') || url.includes('passport.douyin.com')) {
      return { valid: false };
    }

    // 检查 cookie 中是否仍保留 sessionid（被服务器清除则无效）
    const state = await context.storageState();
    const hasSession = hasSessionid(state);
    if (!hasSession) return { valid: false };

    // 进一步检查：访问 /chat 页是否能加载（未登录会被重定向）
    await page.goto('https://www.douyin.com/chat', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2000);
    const chatUrl = page.url();
    log.debug(`[验证] /chat URL: ${chatUrl}`);
    if (chatUrl.includes('login.douyin.com') || chatUrl.includes('passport.douyin.com')) {
      return { valid: false };
    }

    // 最终验证：实际调用 IM API（cmd=2006 conversation/list limit=1）
    // URL 重定向和 cookie 存在不足以证明登录态有效（sessionid 可能已被服务器标记为无效）
    // 只有 API 返回 status=0 才能确认 sessionid 真正可用
    const freshState = await context.storageState();
    const cookieStr = freshState.cookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
    const apiResult = await verifyViaImapi(cookieStr);
    if (!apiResult) {
      log.warn('[验证] 页面未重定向且 cookie 存在，但 IM API 调用失败（sessionid 已失效）');
      return { valid: false };
    }

    return { valid: true, freshState };
  } finally {
    await browser.close();
  }
}

/**
 * 通过实际调用 IM API 验证 sessionid 是否真正有效
 *
 * 发送 cmd=2006 (GET_USER_CONVERSATION_LIST) 请求，limit=1 只拉一条，
 * status=0 表示 sessionid 有效，其他状态码（如 "unexepcted session length"）表示失效。
 *
 * @param cookieStr cookie 字符串
 * @returns true=sessionid 有效
 */
async function verifyViaImapi(cookieStr: string): Promise<boolean> {
  try {
    const env: RequestEnv = { cookie: cookieStr };
    // 构造最小请求：cmd=2006, limit=1，只拉一条会话
    const subBody = Buffer.concat([
      encodeVarintField(1, 2), // sort_type=2
      encodeVarintField(2, 0), // cursor=0
      encodeVarintField(3, 1), // con_type=1 私聊
      encodeVarintField(4, 1), // limit=1
      encodeVarintField(5, 0),
      encodeVarintField(6, 0),
    ]);
    const body = encodeBytesField(2006, subBody);
    const reqBuf = buildRequest({
      cmd: IMAPI_CONSTANTS.IMCMD.GET_USER_CONVERSATION_LIST,
      sequenceId: 99001, // 验证专用序号，不与正常请求冲突
      inboxType: 0,
      body,
      env,
    });

    const resp = await sendImapi({
      path: '/v1/conversation/list',
      body: reqBuf,
      cookie: cookieStr,
    });

    log.debug(`[验证] IM API: status=${resp.statusCode} desc=${resp.errorDesc} body=${resp.body.length}B`);
    return resp.statusCode === 0;
  } catch (e) {
    log.debug(`[验证] IM API 调用异常: ${e}`);
    return false;
  }
}

/** 仅列出当前所有账号（CLI 的 accounts 命令用） */
export async function listAccountsInfo(): Promise<void> {
  const { listAccounts, getCurrentAccount } = await import('../auth/accounts.js');
  const accounts = await listAccounts();
  const current = await getCurrentAccount();

  if (accounts.length === 0) {
    log.info('暂无账号。使用 `sprr login <name>` 登录第一个账号');
    return;
  }

  log.info(`共 ${accounts.length} 个账号（* 标记当前账号）:`);
  for (const a of accounts) {
    const mark = a.name === current ? '*' : ' ';
    const time = new Date(a.savedAt).toLocaleString('zh-CN', { hour12: false });
    const sessionTag = a.hasSessionid ? '已登录' : '无sessionid';
    log.info(
      `  ${mark} ${a.name.padEnd(20)} uid=${a.uid || '?'.padEnd(20)} [${sessionTag}] 保存于 ${time}`,
    );
  }
}
