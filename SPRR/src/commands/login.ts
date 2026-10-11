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

import { chromium, request, type APIRequestContext } from 'playwright';
import fs from 'node:fs/promises';
import { accountFile, saveAccountStorageState, setCurrentAccount } from '../auth/accounts.js';
import { createLogger } from '../utils/logger.js';
import { extractTicketGuardFromPage } from './ticket-guard-auto.js';
import { saveTicketGuard } from '../crypto/ticket-guard.js';
import { IMAPI_CONSTANTS, buildRequest, parseResponse, DEFAULT_UA, type RequestEnv } from '../api/imapi.js';
import { encodeVarintField, encodeBytesField } from '../crypto/protobuf.js';
import { readImapiResponseBody } from '../api/operations.js';
import { probeSession, type SessionValidation } from './session-validation.js';

const log = createLogger('login');

/** 检查 storageState 中是否包含 sessionid cookie（判断登录态） */
function hasSessionid(state: { cookies?: Array<{ name: string; value: string }> }): boolean {
  return Boolean(state.cookies?.some((c) => c.name === 'sessionid' && c.value));
}

/**
 * 启动浏览器扫码登录并保存为指定账号
 *
 * 默认行为（不加 --oc）：如果已有账号且 storageState 中有 sessionid，则沿用上次登录态，
 * 先用最小 IM 只读请求验证，有效则直接复用，明确鉴权失败才提示扫码。
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

  log.info(`登录账号: ${name}（登录页: ${loginUrl}${forceReLogin ? '，强制重新扫码' : ''}）`);
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
        (oldStateObj?.cookies || [])
          .filter((c) => c.name === 'sessionid' || c.name === 'sessionid_ss')
          .map((c) => c.value),
      );
    } catch {
      // 解析失败忽略
    }
  } catch {
    // 无旧账号
  }

  // 已有 sessionid 时只做轻量 IM 验证，不启动 Chromium。
  if (!forceReLogin && existingState && oldStateObj && hasSessionid(oldStateObj)) {
    log.info('检测到已有 sessionid，正在用 IM API 验证登录态...');
    const result = await verifySessionidValid(existingState, oldStateObj);
    if (result.status === 'valid') {
      log.info('✓ 上次登录态仍然有效，直接复用（无需扫码）');
      // 请求 cookie jar 接收服务器旋转后的 cookie；保留原 localStorage。
      const stateToSave = result.freshState || oldStateObj;
      await saveAccountStorageState(name, stateToSave);
      await setCurrentAccount(name);
      const cookieCount = stateToSave.cookies?.length || 0;
      const uid = stateToSave.cookies?.find((c: { name: string; value: string }) => c.name === 'uid_tt')?.value;
      log.info(
        `登录完成：账号 ${name}，共 ${cookieCount} 个 cookie，uid_tt=${uid || '?'}`,
      );
      log.info(`已自动设为当前账号，可直接使用 sprr list / sprr history 等命令`);
      log.info(`如需强制重新扫码，使用: login ${name} --oc`);
      return;
    } else if (result.status === 'invalid') {
      log.warn('✗ 上次登录态已失效，需要重新扫码登录');
    } else {
      throw new Error(`暂时无法验证登录态：${result.reason}。原登录信息已保留，请稍后重试`);
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
  try {
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
    log.info('请在打开的浏览器中扫码登录抖音...');
    log.info(`等待登录完成（超时 ${Math.floor(timeout / 1000)} 秒）`);

    // 等待抖音域名下出现新的 sessionid cookie。
    // 关键：必须等**新** sessionid 出现（不是旧 storageState 已有的）。
    // 否则复用旧账号时会立即误判为登录成功，导致 server 端不认账。
    const startTime = Date.now();
    let loggedIn = false;
    let oldSessionNoticeShown = false;
    while (Date.now() - startTime < timeout) {
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
            break;
          }
        } else if (hasSessionid(state) && initialSessionids.size > 0) {
          if (!oldSessionNoticeShown) {
            log.info('检测到旧 storageState 中残留的 sessionid，等待用户扫码后写入新 sessionid...');
            oldSessionNoticeShown = true;
          }
        }
      } catch {
        // 忽略
      }
      // 只在等待用户扫码期间轮询，cookie 条件满足即退出。
      await page.waitForTimeout(Math.min(250, Math.max(1, timeout - (Date.now() - startTime))));
    }

    if (!loggedIn) {
      throw new Error('登录超时，未检测到 sessionid cookie');
    }

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

    // ticket-guard 初始化也可能更新 cookie，必须最后再导出。
    const finalState = await context.storageState();
    await saveAccountStorageState(name, finalState);

    // 自动设为当前账号
    await setCurrentAccount(name);

    const cookieCount = finalState.cookies?.length || 0;
    const uid = finalState.cookies?.find((c) => c.name === 'uid_tt')?.value;
    log.info(
      `登录完成：账号 ${name}，共 ${cookieCount} 个 cookie，uid_tt=${uid || '?'}`,
    );
    log.info(`已自动设为当前账号，可直接使用 sprr list / sprr history 等命令`);
  } finally {
    await browser.close();
  }
}

/** 无 Chromium 启动开销；请求上下文保存服务端旋转后的 cookie。 */
export async function verifySessionidValid(
  storageStatePath: string,
  originalState: { cookies?: Array<{ name: string; value: string }>; origins?: unknown },
  createRequestContext: typeof request.newContext = request.newContext.bind(request),
): Promise<SessionValidation & { freshState?: any }> {
  let api: APIRequestContext | undefined;
  try {
    api = await createRequestContext({
      storageState: storageStatePath,
      userAgent: DEFAULT_UA,
      extraHTTPHeaders: {
        accept: 'application/x-protobuf',
        'content-type': 'application/x-protobuf',
        origin: 'https://www.douyin.com',
        referer: 'https://www.douyin.com/',
        'accept-language': 'zh-CN,zh;q=0.9',
        'sec-ch-ua': '"Chromium";v="149", "Not)A;Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
        priority: 'u=1, i',
      },
    });
    const client = api;
    const verdict = await probeSession(async () => {
      const state = await client.storageState();
      const cookie = state.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      const env: RequestEnv = { cookie };
      const subBody = Buffer.concat([
        encodeVarintField(1, 2), encodeVarintField(2, 0),
        encodeVarintField(3, 1), encodeVarintField(4, 1),
        encodeVarintField(5, 0), encodeVarintField(6, 0),
      ]);
      const body = buildRequest({
        cmd: IMAPI_CONSTANTS.IMCMD.GET_USER_CONVERSATION_LIST,
        sequenceId: 99001, inboxType: 0,
        body: encodeBytesField(2006, subBody), env,
      });
      const response = await client.post(`${IMAPI_CONSTANTS.apiUrl}/v1/conversation/list`, {
        data: body, timeout: 10_000,
      });
      if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
      const parsed = parseResponse(await response.body());
      if (parsed.cmd !== IMAPI_CONSTANTS.IMCMD.GET_USER_CONVERSATION_LIST) {
        return { statusCode: -1, errorDesc: 'IM 验证响应缺少预期的会话列表指令' };
      }
      if (parsed.statusCode === 0) {
        try {
          readImapiResponseBody(parsed.body, 2006);
        } catch {
          return { statusCode: -1, errorDesc: 'IM 验证响应缺少完整的 body 2006' };
        }
      }
      log.debug(`[验证] IM API: status=${parsed.statusCode} desc=${parsed.errorDesc}`);
      return parsed;
    });
    if (verdict.status !== 'valid') return verdict;
    const freshState = await client.storageState();
    // APIRequestContext 不访问页面，保留浏览器原有 localStorage origins。
    return { status: 'valid', freshState: { ...freshState, origins: originalState.origins ?? freshState.origins } };
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await api?.dispose();
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
