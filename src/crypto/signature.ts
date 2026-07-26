/**
 * 抖音 API 签名（a_bogus / msToken）
 *
 * 纯 Node.js 实现，基于 src/crypto/abogus.ts 的 a_bogus 纯算构造。
 *
 * 算法链路（详见 abogus.ts）：
 *   SM3 二次哈希 → UA 哈希 → payload 组装 → garble_3to4 → RC4 变体 → s4 Base64
 *
 * msToken / verifyFp 来自 Cookie：
 *   - msToken: 风控 token，由抖音服务端颁发，存储在 cookie 中
 *   - verifyFp / fp: 来自 cookie 中的 s_v_web_id
 *
 * 使用方式：
 *   import { sign, extractMsToken, extractVerifyFp } from '../crypto/signature.js';
 *   const { aBogus, msToken } = sign({
 *     url: '/aweme/v1/web/...',
 *     params: { aid: '6383', ... },
 *     method: 'POST',
 *     userAgent: env.userAgent || DEFAULT_UA,
 *     body: '{}',
 *     cookie: env.cookie,
 *   });
 */

import { generateABogus, type ABogusInput } from './abogus.js';

export interface SignInput extends ABogusInput {
  /** Cookie 字符串（用于提取 msToken / verifyFp） */
  cookie?: string;
}

export interface SignResult {
  /** a_bogus 参数（192 字符） */
  aBogus?: string;
  /** msToken（来自 cookie） */
  msToken?: string;
  /** verifyFp / fp（来自 cookie 中的 s_v_web_id） */
  verifyFp?: string;
  /** 需要追加到 query 的参数 */
  query?: Record<string, string>;
}

/**
 * 从 Cookie 字符串中解析指定 key 的值
 */
export function parseCookieValue(cookie: string, key: string): string {
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${key}=([^;]+)`));
  return match ? match[1].trim() : '';
}

/**
 * 从 Cookie 中提取 msToken
 */
export function extractMsToken(cookie: string): string {
  return parseCookieValue(cookie, 'msToken');
}

/**
 * 从 Cookie 中提取 verifyFp（即 s_v_web_id 的值）
 */
export function extractVerifyFp(cookie: string): string {
  return parseCookieValue(cookie, 's_v_web_id');
}

/**
 * 计算签名
 *
 * 生成 a_bogus 参数并从 cookie 中提取 msToken / verifyFp。
 *
 * @param input 签名输入（含 url/params/method/userAgent/body/cookie）
 * @returns 签名结果（aBogus + msToken + verifyFp + query）
 */
export function sign(input: SignInput): SignResult {
  const { cookie = '', ...abogusInput } = input;

  // 生成 a_bogus
  const aBogus = generateABogus(abogusInput);

  // 从 cookie 提取 msToken / verifyFp
  const msToken = extractMsToken(cookie);
  const verifyFp = extractVerifyFp(cookie);

  // 组装需要追加到 URL query 的参数
  const query: Record<string, string> = { a_bogus: aBogus };
  if (msToken) query.msToken = msToken;
  if (verifyFp) {
    query.verifyFp = verifyFp;
    query.fp = verifyFp;
  }

  return { aBogus, msToken, verifyFp, query };
}
