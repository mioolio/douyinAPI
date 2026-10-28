/** 评论在同一个浏览器会话内取得签名并提交，避免复用其他账号或过期的三头。 */
import type { Browser, BrowserContext } from 'playwright';
import { DEFAULT_UA } from '../api/imapi.js';
import {
  buildCommentPublishBody,
  buildCommentPublishParams,
  parseCommentPublishResponse,
  validateCommentOptions,
  type PublishCommentOptions,
  type PublishCommentResult,
} from '../api/webapi.js';
import { createLogger } from '../utils/logger.js';
import { createBrowserDiagnostics } from '../utils/browser-diagnostics.js';
import { isTicketGuardForSession } from '../crypto/ticket-guard.js';
import { waitForSignatureReady } from './signature-ready.js';
import { extractTicketGuardFromPage } from './ticket-guard-auto.js';

const log = createLogger('browser-comment');
const REQUEST_TIMEOUT_MS = 30_000;
const PUBLISH_URL = 'https://www.douyin.com/aweme/v1/web/comment/publish';
const WEB_ORIGIN = 'https://www.douyin.com';
const DETAIL_PATH = '/aweme/v1/web/aweme/detail/';
const SDK_PARAMS = ['a_bogus', 'msToken', 'verifyFp', 'fp'];

interface NativeVideoDetail {
  status_code?: number;
  aweme_detail?: {
    aweme_id?: string;
    status?: { is_delete?: boolean; is_prohibited?: boolean; private_status?: number; allow_comment?: boolean };
    aweme_control?: { can_comment?: boolean };
  } | null;
  filter_detail?: { filter_reason?: string };
}

export async function publishCommentViaBrowser(
  storageStatePath: string,
  opts: PublishCommentOptions,
): Promise<PublishCommentResult> {
  const invalid = validateCommentOptions(opts);
  if (invalid) return { success: false, outcome: 'rejected', reason: invalid };
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let submitted = false;
  let requestTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const { chromium } = await import('playwright');
    log.info('启动评论浏览器，使用当前登录会话自动签名');
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--window-size=1400,900'],
    });
    context = await browser.newContext({
      storageState: storageStatePath,
      userAgent: DEFAULT_UA,
      viewport: { width: 1400, height: 900 },
      screen: { width: 1400, height: 900 },
      locale: 'zh-CN',
    });
    await context.addInitScript("Object.defineProperty(navigator, 'webdriver', { get: () => undefined });");
    const page = await context.newPage();
    const publicParamKeys = new Set([...Object.keys(buildCommentPublishParams({ cookie: '' })), 'uifid']);
    let nativeParams: Record<string, string> | undefined;
    page.on('request', (request) => {
      if (request.method() !== 'GET') return;
      const url = new URL(request.url());
      const webid = url.searchParams.get('webid')?.trim();
      if (url.origin !== WEB_ORIGIN || !url.pathname.startsWith('/aweme/v1/web/')
        || url.searchParams.get('device_platform') !== 'webapp' || !webid || /^0+$/.test(webid)) return;
      // 只复制公共环境参数，避免混入原生接口的 aweme_id、uid、notice 等业务参数。
      const candidate: Record<string, string> = {};
      for (const key of publicParamKeys) {
        const value = url.searchParams.get(key);
        if (value !== null && !SDK_PARAMS.includes(key)) candidate[key] = value;
      }
      nativeParams = { ...(nativeParams?.webid === webid ? nativeParams : {}), ...candidate };
    });
    const diagnostic = createBrowserDiagnostics(log);
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.type() === 'warning') diagnostic(msg.type(), msg.text());
    });
    page.on('pageerror', (error) => diagnostic('pageerror', error.message));
    // 先安装监听，避免快速响应在 goto 完成前被错过；错误转为值，防止导航失败时出现未处理拒绝。
    const detailResponsePending = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.origin === WEB_ORIGIN && url.pathname === DETAIL_PATH
        && url.searchParams.get('aweme_id') === opts.awemeId;
    }, { timeout: 15_000 }).then((response) => ({ response }), () => ({ response: undefined }));
    await page.goto(`https://www.douyin.com/video/${opts.awemeId}`, {
      waitUntil: 'domcontentloaded', timeout: 60_000,
    });
    const { response: detailResponse } = await detailResponsePending;
    if (!detailResponse) throw new Error('未能在 15 秒内确认目标视频详情，评论尚未提交');
    const detailHttpStatus = detailResponse.status();
    if (!detailResponse.ok()) {
      return { success: false, outcome: 'rejected', httpStatus: detailHttpStatus, reason: `评论尚未提交：视频详情请求 HTTP ${detailHttpStatus}，无法确认作品可用` };
    }
    const detail = await detailResponse.json() as NativeVideoDetail;
    if (detail.status_code !== 0) {
      return { success: false, outcome: 'rejected', httpStatus: detailHttpStatus, statusCode: detail.status_code, reason: `评论尚未提交：视频详情返回异常状态 ${detail.status_code ?? '缺失'}，无法确认作品可用` };
    }
    const video = detail.aweme_detail;
    if (!video || video.aweme_id !== opts.awemeId) {
      const filterReason = detail.filter_detail?.filter_reason;
      if (filterReason === 'status_deleted') throw new Error('目标作品存在权限限制或已删除（status_deleted），不能发布评论');
      if (filterReason?.includes('private')) throw new Error(`目标作品权限受限（${filterReason}），不能发布评论`);
      throw new Error('视频详情未返回匹配的作品，无法确认目标视频可用');
    }
    if (video.status?.is_delete === true) throw new Error('目标作品已删除，不能发布评论');
    if (video.status?.is_prohibited === true) throw new Error('目标作品受到访问限制，不能发布评论');
    if (typeof video.status?.private_status === 'number' && video.status.private_status !== 0) {
      throw new Error('目标作品权限受限（private_status），不能发布评论');
    }
    if (video.status?.allow_comment === false || video.aweme_control?.can_comment === false) {
      throw new Error('目标作品已关闭评论，不能发布评论');
    }
    const cookies = await context.cookies(PUBLISH_URL);
    if (!cookies.some((cookie) => ['sessionid', 'sessionid_ss'].includes(cookie.name) && cookie.value)) {
      throw new Error('当前会话缺少 sessionid，请重新登录');
    }
    await waitForSignatureReady(page);
    const guard = await extractTicketGuardFromPage(page, { skipNavigate: true, secsdkReadySecs: 0 });
    if (!guard) throw new Error('未获取到完整的评论签名，请检查登录状态后重试');

    // 探测期间 Cookie 可能更新，先确认仍是同一登录会话。
    const currentCookies = await context.cookies(PUBLISH_URL);
    const cookie = currentCookies.map((entry) => `${entry.name}=${entry.value}`).join('; ');
    if (!isTicketGuardForSession(guard, cookie)) {
      throw new Error('签名初始化期间登录会话发生变化，请重新登录后重试');
    }
    if (!nativeParams?.webid || /^0+$/.test(nativeParams.webid)) {
      throw new Error('未观察到包含有效 webid 的原生请求参数，评论尚未提交');
    }
    if (!nativeParams.uifid) throw new Error('未观察到原生 uifid，评论尚未提交');
    const params = { ...buildCommentPublishParams({ cookie }), ...nativeParams };
    params.enter_from = 'video_detail';
    params.previous_page = 'video_detail';
    // SDK 会为本次请求追加当前会话的签名参数，预填会产生重复字段。
    for (const name of SDK_PARAMS) delete params[name];
    const body = buildCommentPublishBody(opts);
    submitted = true;
    const response = await Promise.race([
      page.evaluate(({ params, body, timeoutMs }) => new Promise<{ status: number; text: string; verifyDecision?: string }>((resolve, reject) => {
        // 原生页面走 XHR；SDK 的 XHR 钩子还会追加当前账号 UID 的哈希。
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/aweme/v1/web/comment/publish?${new URLSearchParams(params)}`, true);
        xhr.withCredentials = true;
        xhr.timeout = timeoutMs;
        const headers: Record<string, string> = {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'x-secsdk-csrf-token': 'DOWNGRADE',
          uifid: params.uifid,
        };
        for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
        // 风控质询时 HTTP 200 + 空响应体，真实语义在 x-tt-verify-passport-decision 头。
        xhr.onload = () => resolve({
          status: xhr.status,
          text: xhr.responseText,
          verifyDecision: xhr.getResponseHeader('x-tt-verify-passport-decision') ?? undefined,
        });
        xhr.onerror = () => reject(new Error('评论请求网络错误'));
        xhr.ontimeout = () => reject(new Error('评论请求超时'));
        xhr.onabort = () => reject(new Error('评论请求已中止'));
        xhr.send(body);
      }), { params, body, timeoutMs: REQUEST_TIMEOUT_MS }),
      new Promise<never>((_resolve, reject) => {
        requestTimer = setTimeout(() => reject(new Error('评论请求超时')), REQUEST_TIMEOUT_MS);
      }),
    ]);
    const result = parseCommentPublishResponse(response.status, response.text, response.verifyDecision);
    if (!result.success) log.warn(result.reason || '无法确认评论发布结果');
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false, outcome: submitted ? 'unknown' : 'rejected',
      reason: submitted ? `无法确认评论是否已发布：${message}` : `评论尚未提交：${message}`,
    };
  } finally {
    clearTimeout(requestTimer);
    try { await context?.close(); } catch {}
    try { await browser?.close(); } catch {}
  }
}
