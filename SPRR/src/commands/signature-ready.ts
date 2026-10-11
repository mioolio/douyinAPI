import { randomUUID } from 'node:crypto';
import type { Page, Route } from 'playwright';

const TOKEN_PATH = '/passport/safe/get_identity_security_token/';

/** 仅拦截自己的只读探针；正常 token 查询和消息发送不会匹配。 */
export function isSignatureProbe(url: URL, marker: string): boolean {
  return url.origin === 'https://www.douyin.com'
    && url.pathname === TOKEN_PATH
    && url.searchParams.get('biz_trace_id') === marker;
}

/** 项目发送链路使用 SDK 自动加入 URL 的 a_bogus；fetch 存在不代表已加签。 */
export function hasRequestSignature(url: string): boolean {
  return Boolean(new URL(url).searchParams.get('a_bogus'));
}

/**
 * 在已使用的 identity-token 只读接口上检测真实自动加签能力。
 * 探针被 route 本地响应，不拉 token；随后正常 token 请求仍只发生一次。
 * 可选 guard 头不作为硬条件，避免 SDK 版本差异造成错误超时。
 */
export async function waitForSignatureReady(
  page: Page,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    now?: () => number;
    pause?: (ms: number) => Promise<void>;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollMs = options.pollMs ?? 250;
  const now = options.now ?? Date.now;
  const pause = options.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  const marker = randomUUID().replace(/-/g, '').slice(0, 8);
  const matcher = (url: URL) => isSignatureProbe(url, marker);
  let ready = false;
  const handler = async (route: Route) => {
    ready = hasRequestSignature(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    });
  };
  await page.route(matcher, handler);
  try {
    while (now() < deadline) {
      // 参数与 getIdentitySecurityToken 相同；唯一 biz_trace_id 使拦截范围明确。
      await page.evaluate(async ({ marker, timeoutMs }) => {
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<void>((resolve) => {
          timer = setTimeout(() => { controller.abort(); resolve(); }, timeoutMs);
        });
        try {
          const params = new URLSearchParams({
            passport_jssdk_version: '4.2.3', passport_jssdk_type: 'lite',
            is_from_ttaccountsdk: '1', aid: '6383', language: 'zh', scene: 'web_im',
            auto_retry_req: '0', skip_verify: 'false', identity_token_force_get_tag: '0',
            biz_trace_id: marker, id_token_version: '1.2.10',
          });
          await Promise.race([fetch(`/passport/safe/get_identity_security_token/?${params}`, {
            credentials: 'include', signal: controller.signal,
            headers: {
              accept: 'application/json, text/javascript',
              'x-tt-passport-csrf-token': (document.cookie.match(/passport_csrf_token=([^;]+)/) || [])[1] || '',
            },
          }), expired]);
        } catch {
          // 页面重定向/SDK 初始化中的请求异常会在截止前重试。
        } finally {
          clearTimeout(timer);
        }
      }, { marker, timeoutMs: Math.max(1, Math.min(2000, deadline - now())) });
      if (ready) return;
      await pause(Math.max(0, Math.min(pollMs, deadline - now())));
    }
    throw new Error(`自动签名 SDK 未就绪：${timeoutMs}ms 内未检测到 a_bogus，请稍后重试`);
  } finally {
    await page.unroute(matcher, handler);
  }
}
