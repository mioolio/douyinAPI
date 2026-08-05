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

const log = createLogger('login');

/** 检查 storageState 中是否包含 sessionid cookie（判断登录态） */
function hasSessionid(state: { cookies?: Array<{ name: string; value: string }> }): boolean {
  return Boolean(state.cookies?.some((c) => c.name === 'sessionid' && c.value));
}

/**
 * 启动浏览器扫码登录并保存为指定账号
 *
 * @param name 账号名
 * @param options.headless 是否无头模式（默认 false，登录必须 headful）
 * @param options.timeout 登录超时（毫秒，默认 5 分钟）
 */
export async function loginAccount(
  name: string,
  options: { headless?: boolean; timeout?: number } = {},
): Promise<void> {
  const headless = options.headless ?? false;
  const timeout = options.timeout ?? 5 * 60 * 1000;

  log.info(`启动浏览器登录账号: ${name}`);
  if (headless) {
    log.warn('headless 模式下无法扫码，仅用于复用已有 storageState 测试');
  }

  // 已有同名账号：加载旧 storageState 作为初始状态
  // 仅当有旧账号时记录初始 sessionid（用于区分"新登录" vs "复用旧 sessionid"）
  let existingState: string | undefined;
  let initialSessionids: Set<string> = new Set();
  try {
    await fs.access(accountFile(name));
    existingState = accountFile(name);
    log.info(`检测到已有账号 ${name}，加载旧 storageState（如果是已登录状态可直接使用）`);
    try {
      const oldState = JSON.parse(await fs.readFile(accountFile(name), 'utf-8')) as {
        cookies?: Array<{ name: string; value: string }>;
      };
      initialSessionids = new Set(
        (oldState.cookies || [])
          .filter((c) => c.name === 'sessionid' || c.name === 'sessionid_ss')
          .map((c) => c.value),
      );
    } catch {
      // 解析失败忽略
    }
  } catch {
    // 无旧账号
  }

  const browser = await chromium.launch({
    headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      // 禁用弹窗：阻止 window.open / target=_blank 创建新窗口
      '--disable-popup-blocking',
    ],
  });
  const context = await browser.newContext(
    existingState
      ? { storageState: existingState }
      : {
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          viewport: { width: 1400, height: 900 },
          locale: 'zh-CN',
        },
  );

  // 注入 webdriver 隐藏脚本 + 阻止弹窗跳转
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // 阻止 window.open（防止疯狂弹新标签）
    (window as unknown as { open: () => null }).open = () => {
      console.warn('[blocked] window.open');
      return null;
    };
  });

  // 路由级拦截：仅拦截用户明确列出的风控跳转域名
  // 不使用宽泛匹配（如 -cn-static.com），避免误伤抖音自身资源加载导致页面加载失败
  await context.route('**/*', (route) => {
    const reqUrl = route.request().url();
    let hostname = '';
    try {
      hostname = new URL(reqUrl).hostname;
    } catch {
      return route.continue();
    }
    // 仅拦截用户明确列出的风控域名：yhgfb-cn-static.com（含子域 If-rc1.yhgfb-cn-static.com）
    const isRiskDomain =
      hostname === 'yhgfb-cn-static.com' ||
      hostname.endsWith('.yhgfb-cn-static.com');
    if (isRiskDomain) {
      console.warn('[blocked] risk domain', hostname);
      return route.abort();
    }
    return route.continue();
  });

  // 拦截新页面（target=_blank / window.open 即使绕过也会触发 page 事件）
  // 注意：不拦截 about:blank（初始空白页）和主 page 的第一次导航
  let mainPageReady = false;
  context.on('page', async (newPage) => {
    const url = newPage.url();
    // 跳过初始空白页
    if (url === 'about:blank' || url === '') {
      if (!mainPageReady) {
        mainPageReady = true;
        return;
      }
    }
    try {
      log.warn(`[blocked] 检测到新页面打开，立即关闭: ${url}`);
      await newPage.close();
    } catch {
      // 忽略
    }
  });

  const page = await context.newPage();
  mainPageReady = true;
  // 阻止 page 级别的弹窗（confirm/alert 也会被自动处理）
  page.on('popup', async (popup) => {
    try {
      log.warn(`[blocked] 检测到弹窗，立即关闭: ${popup.url()}`);
      await popup.close();
    } catch {
      // 忽略
    }
  });

  // 访问抖音主页（不使用 /login，那个 URL 不存在；不使用 /chat?isPopup=1，会触发风控）
  // 主页右上角有登录入口，可扫码登录
  await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
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
