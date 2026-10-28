/** 通过被本地拦截的无效评论探针，检测浏览器 SDK 并获取 ticket-guard。 */
import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Page, Route } from 'playwright';
import { createLogger } from '../utils/logger.js';
import { ticketGuardSessionFingerprint, type TicketGuardConfig } from '../crypto/ticket-guard.js';

const log = createLogger('ticket-guard-auto');
const VIDEO_PAGE_URL = 'https://www.douyin.com/?modal_id=7666440815748969905';
const PUBLISH_PATH = '/aweme/v1/web/comment/publish';
const PROBE_PARAM = '__sprr_ticket_guard_probe';
const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_MS = 250;
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** 只匹配本次探针的 URL；处理器还会校验 POST 和 aweme_id=0。 */
export function isTicketGuardProbe(url: URL, marker: string): boolean {
  return url.origin === 'https://www.douyin.com'
    && url.pathname === PUBLISH_PATH
    && url.searchParams.get(PROBE_PARAM) === marker;
}

/**
 * 在已有页面中提取三头。缺头时继续探测；所有探针都被本地响应。
 * timeoutMs 覆盖导航、初始化等待及 evaluate，结束时移除本次拦截器。
 */
export async function extractTicketGuardFromPage(
  page: Page,
  options: { skipNavigate?: boolean; secsdkReadySecs?: number; timeoutMs?: number } = {},
): Promise<TicketGuardConfig | null> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  const marker = randomUUID();
  const matcher = (url: URL) => isTicketGuardProbe(url, marker);
  let stopped = false;
  let registered = false;
  let captured: TicketGuardConfig | null = null;
  let captureResolve: (value: TicketGuardConfig) => void;
  const capturePromise = new Promise<TicketGuardConfig>((resolve) => { captureResolve = resolve; });
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const pause = (ms: number) => new Promise<void>((resolve) => { retryTimer = setTimeout(resolve, ms); });

  const handler = async (route: Route) => {
    const request = route.request();
    if (request.method() !== 'POST'
      || new URLSearchParams(request.postData() || '').get('aweme_id') !== '0') {
      await route.fallback();
      return;
    }
    try {
      const headers = await request.allHeaders();
      const clientData = headers['bd-ticket-guard-client-data'];
      const reePublicKey = headers['bd-ticket-guard-ree-public-key'];
      const sessionDtrait = headers['x-tt-session-dtrait'];
      // 只给自己的探针返回响应，不伪造可被当作真实评论成功的 cid。
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      if (!stopped && clientData && reePublicKey && sessionDtrait) {
        captured = {
          clientData, reePublicKey, sessionDtrait,
          capturedAt: Date.now(),
          capturedFrom: 'auto:playwright',
          sessionFingerprint: ticketGuardSessionFingerprint(headers.cookie || ''),
        };
        captureResolve(captured);
      }
    } catch (error) {
      log.debug('ticket-guard 探针拦截异常', error);
      try { await route.abort(); } catch {}
    }
  };

  try {
    await page.route(matcher, handler);
    registered = true;
    const expired = new Promise<null>((resolve) => {
      timeoutTimer = setTimeout(() => { stopped = true; resolve(null); }, Math.max(1, deadline - Date.now()));
    });
    const probe = async (): Promise<TicketGuardConfig | null> => {
      if (!options.skipNavigate) {
        log.info(`导航到视频页 ${VIDEO_PAGE_URL}`);
        await page.goto(VIDEO_PAGE_URL, {
          waitUntil: 'domcontentloaded', timeout: Math.max(1, deadline - Date.now()),
        });
      }
      const initialWait = Math.max(0, (options.secsdkReadySecs ?? 0) * 1000);
      if (initialWait && !stopped) await pause(Math.min(initialWait, Math.max(0, deadline - Date.now())));
      while (!stopped && Date.now() < deadline) {
        // fetch 自身也限时；外层截止时间防止 SDK 包装器/evaluate 挂起。
        await Promise.race([
          page.evaluate(async ({ marker, probeParam, timeoutMs }) => {
            const controller = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const expired = new Promise<void>((resolve) => {
              timer = setTimeout(() => { controller.abort(); resolve(); }, timeoutMs);
            });
            try {
              const params = new URLSearchParams({
                device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web',
                pc_client_type: '1', update_version_code: '170400', version_code: '170400',
                version_name: '17.4.0', cookie_enabled: 'true', platform: 'PC',
                [probeParam]: marker,
              });
              await Promise.race([fetch(`/aweme/v1/web/comment/publish?${params}`, {
                method: 'POST', credentials: 'include', signal: controller.signal,
                headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ aweme_id: '0', text: 'test', text_extra: '[]' }).toString(),
              }), expired]);
            } catch {
              // 页面/SDK 初始化期间失败可在截止前重试。
            } finally {
              clearTimeout(timer);
            }
          }, { marker, probeParam: PROBE_PARAM, timeoutMs: Math.max(1, Math.min(2000, deadline - Date.now())) }),
          capturePromise,
        ]);
        if (captured) return captured;
        if (!stopped) await pause(Math.max(0, Math.min(POLL_MS, deadline - Date.now())));
      }
      return null;
    };
    const result = await Promise.race([probe(), expired]);
    if (result) log.info('已捕获完整 ticket-guard 三头');
    else log.error(`${timeoutMs}ms 内未捕获完整 ticket-guard 三头，请检查登录态或稍后重试`);
    return result;
  } catch (error) {
    log.error('extractTicketGuardFromPage 异常', error);
    return null;
  } finally {
    stopped = true;
    clearTimeout(timeoutTimer);
    clearTimeout(retryTimer);
    if (registered) {
      try { await page.unroute(matcher, handler); } catch {}
    }
  }
}

export interface AutoExtractOptions {
  headless?: boolean;
  /** 导航与探测的总超时，默认 60 秒。 */
  timeoutMs?: number;
  /** 可选同步浏览器更新后的 Cookie；提取器不持久化原始 Cookie。 */
  onCookieUpdated?: (cookie: string) => void;
}

/** 独立浏览器模式；初始化的任意阶段失败都会回收已创建的资源。 */
export async function autoExtractTicketGuard(
  storageStatePath: string,
  options: AutoExtractOptions = {},
): Promise<TicketGuardConfig | null> {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({
      headless: options.headless ?? true,
      args: ['--disable-blink-features=AutomationControlled', '--window-size=1400,900'],
    });
    context = await browser.newContext({
      storageState: storageStatePath, userAgent: DEFAULT_UA,
      viewport: { width: 1400, height: 900 }, locale: 'zh-CN',
    });
    await context.addInitScript(`
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      window.chrome = window.chrome || { runtime: {} };
    `);
    const page = await context.newPage();
    const result = await extractTicketGuardFromPage(page, { timeoutMs: options.timeoutMs });
    if (result) {
      const cookies = await context.cookies(`https://www.douyin.com${PUBLISH_PATH}`);
      const cookie = cookies.filter((entry) => entry.name).map((entry) => `${entry.name}=${entry.value}`).join('; ');
      result.sessionFingerprint = ticketGuardSessionFingerprint(cookie);
      options.onCookieUpdated?.(cookie);
    }
    return result;
  } catch (error) {
    log.error('浏览器自动获取 ticket-guard 失败', error);
    return null;
  } finally {
    try { await context?.close(); } catch {}
    try { await browser?.close(); } catch {}
  }
}
