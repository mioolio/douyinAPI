/**
 * 通过 Playwright 自动获取 bd-ticket-guard 三头
 *
 * 背景：
 *   - bd-ticket-guard-client-data / bd-ticket-guard-ree-public-key / x-tt-session-dtrait
 *     三个头由浏览器 secsdk/webmssdk.js 在运行时生成
 *   - 纯算逆向结论（2026-07-26）：ree_public_key 是客户端 ECDH 公钥，ECDH 共享密钥
 *     可本地计算，但 req_sign 的 HMAC 密钥派生和 x-tt-session-dtrait 的生成使用
 *     webmssdk.es5.js 中 VM 保护的自定义 KDF，无法在纯 Node.js 中复现
 *   - 三个头在会话内完全静态（timestamp 固定），获取一次即可复用
 *
 * 实现策略：
 *   1. 在已打开的浏览器中（或新建 headless 浏览器）导航到抖音视频页
 *   2. 用 page.route 拦截 /aweme/v1/web/comment/publish 请求
 *   3. 在浏览器内执行 fetch 触发一个 comment_publish 请求（用无效 aweme_id=0）
 *   4. 拦截器提取三头后用 route.fulfill() 返回伪造响应，请求不会真的发到服务器
 *   5. 返回三头配置
 *
 * 主要入口：
 *   - extractTicketGuardFromPage(page): 复用已有 Playwright Page（如 login 命令的浏览器）
 *   - autoExtractTicketGuard(storageStatePath): 独立启动 headless 浏览器（ticket-guard --auto 命令）
 */

import type { Page } from 'playwright';
import { createLogger } from '../utils/logger.js';
import type { TicketGuardConfig } from '../crypto/ticket-guard.js';

const log = createLogger('ticket-guard-auto');

/** 抖音视频页 URL（任意有效视频均可，用于触发 secsdk 初始化） */
const VIDEO_PAGE_URL = 'https://www.douyin.com/?modal_id=7666440815748969905';

/** 浏览器 UA（与项目其他模块保持一致） */
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** 探测请求触发后的等待超时（毫秒） */
const CAPTURE_TIMEOUT_MS = 15_000;

/** secsdk 初始化等待时间（毫秒） */
const SECSDK_INIT_WAIT_MS = 5_000;

/**
 * 在已有的 Playwright Page 上提取 ticket-guard 三头
 *
 * 核心逻辑：导航到视频页 → 等待 secsdk 初始化 → 拦截 comment_publish 请求 → 触发探测请求 → 提取三头
 *
 * @param page 已打开的 Playwright Page（需有登录态）
 * @param options.skipNavigate 若已在抖音页面可跳过导航（默认 false）
 * @param options.secsdkReadySecs secsdk 等待秒数（默认 5）
 * @returns 三头配置；失败返回 null
 */
export async function extractTicketGuardFromPage(
  page: Page,
  options: { skipNavigate?: boolean; secsdkReadySecs?: number } = {},
): Promise<TicketGuardConfig | null> {
  const { skipNavigate = false, secsdkReadySecs = SECSDK_INIT_WAIT_MS / 1000 } = options;

  let captured: TicketGuardConfig | null = null;
  let captureResolve: ((v: TicketGuardConfig | null) => void) | null = null;
  const capturePromise = new Promise<TicketGuardConfig | null>((resolve) => {
    captureResolve = resolve;
  });

  // 用 page.route 拦截 comment_publish 请求
  // 在请求发出前拦截，提取三头后返回伪造响应，请求不会真的发到服务器
  await page.route('**/aweme/v1/web/comment/publish**', async (route) => {
    const request = route.request();
    const headers = await request.allHeaders();

    const clientData = headers['bd-ticket-guard-client-data'];
    const reePublicKey = headers['bd-ticket-guard-ree-public-key'];
    const sessionDtrait = headers['x-tt-session-dtrait'];

    log.debug(
      `拦截 comment_publish: clientData=${clientData ? clientData.length + 'chars' : '缺失'}, reePublicKey=${reePublicKey ? '有' : '缺失'}, dtrait=${sessionDtrait ? sessionDtrait.length + 'chars' : '缺失'}`,
    );

    if (clientData && reePublicKey && sessionDtrait) {
      captured = {
        clientData,
        reePublicKey,
        sessionDtrait,
        capturedAt: Date.now(),
        capturedFrom: 'auto:playwright',
      };
      log.info('已捕获完整 ticket-guard 三头');
      captureResolve?.(captured);
    } else {
      log.warn('拦截到的请求三头不完整，secsdk 可能未完成初始化');
    }

    // 返回伪造响应，阻止请求真的发到服务器
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status_code: 0, comment: { cid: '0' } }),
    });
  });

  try {
    if (!skipNavigate) {
      log.info(`导航到视频页 ${VIDEO_PAGE_URL}`);
      await page.goto(VIDEO_PAGE_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
    }

    // 等待 secsdk 初始化
    log.info(`等待 secsdk 初始化（${secsdkReadySecs} 秒）...`);
    await page.waitForTimeout(secsdkReadySecs * 1000);

    // 触发 comment_publish 请求（用无效 aweme_id，服务端会拒绝，但 secsdk 会添加三头）
    log.info('触发探测请求（aweme_id=0，不会真的发布评论）');
    await page.evaluate(async () => {
      try {
        const params = new URLSearchParams({
          device_platform: 'webapp',
          aid: '6383',
          channel: 'channel_pc_web',
          pc_client_type: '1',
          update_version_code: '170400',
          version_code: '170400',
          version_name: '17.4.0',
          cookie_enabled: 'true',
          platform: 'PC',
        });
        const url = `/aweme/v1/web/comment/publish?${params.toString()}`;
        const body = new URLSearchParams({
          aweme_id: '0',
          text: 'test',
          text_extra: '[]',
        });
        await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
        });
      } catch {
        // 忽略错误，我们只关心请求头
      }
    });

    // 等待捕获完成
    const result = await Promise.race([
      capturePromise,
      new Promise<TicketGuardConfig | null>((resolve) =>
        setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS),
      ),
    ]);

    if (!result) {
      log.error(`${CAPTURE_TIMEOUT_MS / 1000} 秒内未捕获到完整三头`);
      log.error('可能原因：1) cookie 已过期；2) secsdk 未初始化；3) 页面结构变化');
      return null;
    }

    return result;
  } catch (e) {
    log.error('extractTicketGuardFromPage 异常', e);
    return null;
  }
}

/** 自动提取选项（独立启动浏览器模式） */
export interface AutoExtractOptions {
  /** 是否无头模式（默认 true） */
  headless?: boolean;
  /** 总超时毫秒数（默认 60 秒） */
  timeoutMs?: number;
}

/**
 * 独立启动 headless 浏览器自动获取 ticket-guard 三头
 *
 * 用于 `sprr ticket-guard --auto` 命令：加载 storageState → 启动浏览器 → 提取三头 → 关闭浏览器
 *
 * @param storageStatePath storageState 文件路径（即用户登录后的 cookie 持久化文件）
 * @param options 选项
 * @returns 三头配置；失败返回 null
 */
export async function autoExtractTicketGuard(
  storageStatePath: string,
  options: AutoExtractOptions = {},
): Promise<TicketGuardConfig | null> {
  const { headless = true } = options;

  let chromium: typeof import('playwright').chromium;
  try {
    const mod = await import('playwright');
    chromium = mod.chromium;
  } catch {
    log.error('未安装 playwright，请运行 `npm install -D playwright` 后重试');
    log.error('或使用 `sprr ticket-guard --from-capture` 从已有抓包数据提取');
    return null;
  }

  log.info(
    `启动浏览器（storageState: ${storageStatePath}, headless: ${headless}）`,
  );

  const browser = await chromium.launch({
    headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--window-size=1400,900',
    ],
  });

  const context = await browser.newContext({
    storageState: storageStatePath,
    userAgent: DEFAULT_UA,
    viewport: { width: 1400, height: 900 },
    locale: 'zh-CN',
  });

  // 反检测
  await context.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    window.chrome = window.chrome || { runtime: {} };
  `);

  const page = await context.newPage();

  // 转发浏览器 console 到 Node logger
  page.on('console', (msg) => {
    const type = msg.type();
    if (type === 'error' || type === 'warning') {
      log.warn(`[browser:${type}] ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => {
    log.warn(`[browser:pageerror] ${err.message}`);
  });

  try {
    const result = await extractTicketGuardFromPage(page);
    return result;
  } finally {
    try {
      await context.close();
    } catch {}
    try {
      await browser.close();
    } catch {}
  }
}
