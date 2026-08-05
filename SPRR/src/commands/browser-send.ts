/**
 * 浏览器发送消息（自动签名）
 *
 * 原理：
 *   抖音 IM send_message 接口需要 4 层签名：
 *     1. URL query: a_bogus + msToken + verifyFp + fp
 *     2. HTTP headers: bd-ticket-guard-client-data / ree-public-key / x-tt-session-dtrait
 *     3. Body headers map: identity_security_token
 *     4. Cookie: sessionid 等
 *
 *   其中 bd-ticket-guard-* 由 webmssdk.es5.js 中 VM 保护的字节码生成，
 *   无法在纯 Node.js 中复现。因此通过浏览器 page.evaluate 执行 fetch，
 *   让 secsdk 自动注入所有签名头和 URL 参数。
 *
 * 流程：
 *   1. 启动浏览器（复用 storageState），导航到 douyin.com 主页
 *   2. 等待 secsdk 初始化
 *   3. 从浏览器页面调用 /passport/safe/get_identity_security_token/ 获取 token
 *      （secsdk 自动为此请求加签名）
 *   4. 在 Node.js 中构造 protobuf body（含 identity_security_token JSON 包装）
 *   5. 将 body 以 base64 传入 page.evaluate，执行 fetch 到 imapi.douyin.com
 *      （secsdk 自动注入 a_bogus/msToken/bd-ticket-guard-* 等签名）
 *   6. 将响应 base64 传回 Node.js 解析
 *
 * 关键发现（对比抓包 send-2026-08-05T16-43-40 修复）：
 *   - identity_security_token 在 body headers map 中需 JSON 包装为 {"token":"<raw>"}
 *   - 原实现直接放 raw token，导致服务端返回空响应 (body=0B)
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../utils/logger.js';
import {
  IMAPI_CONSTANTS,
  buildRequest,
  parseResponse,
  type RequestEnv,
} from '../api/imapi.js';
import {
  encodeVarintField,
  encodeStringField,
  encodeBytesField,
  parseFields,
  findField,
  readVarint,
  readVarintBigint,
  readString,
  readMessage,
} from '../crypto/protobuf.js';
import type { QuoteReplyRef } from '../api/operations.js';

const log = createLogger('browser-send');

/** 浏览器 UA（与抓包样本一致） */
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** 抖音主站 URL（secsdk 在任意 douyin.com 页面都会加载） */
const DOUYIN_URL = 'https://www.douyin.com/';

/** secsdk 初始化等待时间（毫秒） */
const SECSDK_WAIT_MS = 5_000;

/** 全局自增 sequence_id */
let _browserSeq = 20001;
function nextBrowserSeq(): number {
  return _browserSeq++;
}

/** 浏览器发送签名上下文（简化版，仅需会话信息） */
export interface BrowserSendSign {
  /** conversation_short_id（int64） */
  conversationShortId: number | string | bigint;
  /** conversation_type（默认 1=私聊） */
  conversationType?: number;
  /** 会话 ticket */
  ticket?: string;
}

/** 发送结果 */
export interface BrowserSendResult {
  success: boolean;
  msgId?: string;
  serverMsgId?: string;
  reason?: string;
}

/**
 * 浏览器发送器（保持浏览器打开，用于多次发送）
 *
 * 用于 watch --ai 等需要持续发送消息的场景。
 * 避免每次发送都重新启动浏览器。
 */
export class BrowserSender {
  private browser: import('playwright').Browser | null = null;
  private context: import('playwright').BrowserContext | null = null;
  private page: import('playwright').Page | null = null;
  private storageStatePath: string;
  private headless: boolean;
  /** identity_security_token 缓存（会话级有效，无需每次重新获取） */
  private cachedToken: { token: string; deviceId: string } | null = null;

  constructor(storageStatePath: string, headless = true) {
    this.storageStatePath = storageStatePath;
    this.headless = headless;
  }

  /** 启动浏览器并等待 secsdk 就绪 */
  async launch(): Promise<void> {
    const { chromium } = await import('playwright');
    log.info(`BrowserSender: 启动浏览器 (headless=${this.headless})`);

    this.browser = await chromium.launch({
      headless: this.headless,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--window-size=1400,900',
      ],
    });

    this.context = await this.browser.newContext({
      storageState: this.storageStatePath,
      userAgent: DEFAULT_UA,
      // headful 模式下 viewport=null 让页面视口跟随窗口大小（全屏化时内容自动适应）
      // headless 模式下使用固定视口
      viewport: this.headless ? { width: 1400, height: 900 } : null,
      screen: { width: 1920, height: 1080 },
      locale: 'zh-CN',
    });

    // 反检测
    await this.context.addInitScript(`
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    `);

    this.page = await this.context.newPage();

    // 转发浏览器 console
    this.page.on('console', (msg) => {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        log.warn(`[browser:${type}] ${msg.text()}`);
      }
    });
    this.page.on('pageerror', (err) => {
      log.warn(`[browser:pageerror] ${err.message}`);
    });

    log.info(`BrowserSender: 导航到 ${DOUYIN_URL}`);
    await this.page.goto(DOUYIN_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });

    log.info(`BrowserSender: 等待 secsdk 初始化 (${SECSDK_WAIT_MS}ms)`);
    await this.page.waitForTimeout(SECSDK_WAIT_MS);

    log.info('BrowserSender: 浏览器就绪');
  }

  /** 获取 identity_security_token（带缓存） */
  private async getIdentitySecurityToken(): Promise<{
    token: string;
    deviceId: string;
  } | null> {
    if (this.cachedToken) {
      log.debug('BrowserSender: 使用缓存的 identity_security_token');
      return this.cachedToken;
    }

    if (!this.page) return null;

    log.info('BrowserSender: 获取 identity_security_token...');
    const result = await this.page.evaluate(async () => {
      try {
        // 完整参数（对照抓包 sample: token-2026-08-05T17-22-15-102Z-1.json）
        // secsdk 会自动为此请求注入 msToken/a_bogus/bd-ticket-guard-*/x-tt-session-dtrait 等签名
        const params = new URLSearchParams({
          passport_jssdk_version: '4.2.3',
          passport_jssdk_type: 'lite',
          is_from_ttaccountsdk: '1',
          aid: '6383',
          language: 'zh',
          scene: 'web_im',
          auto_retry_req: '0',
          skip_verify: 'false',
          identity_token_force_get_tag: '0',
          biz_trace_id: Math.random().toString(16).slice(2, 10),
          id_token_version: '1.2.10',
        });
        const url = `/passport/safe/get_identity_security_token/?${params}`;
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            accept: 'application/json, text/javascript',
            'x-tt-passport-csrf-token': (document.cookie.match(/passport_csrf_token=([^;]+)/) || [])[1] || '',
          },
          credentials: 'include',
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          return { ok: false, reason: `HTTP ${res.status}`, body: text.slice(0, 500) };
        }
        const text = await res.text();
        let j: any;
        try { j = JSON.parse(text); } catch { return { ok: false, reason: 'JSON parse failed', body: text.slice(0, 500) }; }
        // 尝试多种响应结构
        const token = j.data?.identity_security_token || j.identity_security_token || j.data?.token;
        const deviceId = j.data?.device_id || j.device_id || '';
        if (!token) {
          return { ok: false, reason: 'no token in response', body: text.slice(0, 500), keys: Object.keys(j) };
        }
        return { ok: true, token, deviceId };
      } catch (e) {
        return { ok: false, reason: String(e) };
      }
    });

    if (!result.ok) {
      log.error(`BrowserSender: 获取 token 失败: ${result.reason}`);
      if (result.body) log.error(`BrowserSender: 响应内容: ${result.body}`);
      if (result.keys) log.error(`BrowserSender: 响应顶层字段: ${result.keys.join(', ')}`);
      return null;
    }

    log.info(
      `BrowserSender: token 获取成功 (deviceId=${result.deviceId}, token=${result.token.slice(0, 16)}...)`,
    );
    this.cachedToken = { token: result.token, deviceId: result.deviceId };
    return this.cachedToken;
  }

  /**
   * 发送文本消息
   *
   * @param env 请求环境（含 cookie）
   * @param conversationId 会话 ID
   * @param text 文本内容
   * @param sign 会话签名信息
   */
  async send(
    env: RequestEnv,
    conversationId: string,
    text: string,
    sign: BrowserSendSign,
  ): Promise<BrowserSendResult> {
    if (!this.page) {
      return { success: false, reason: '浏览器未启动，请先调用 launch()' };
    }

    const clientMessageId = randomUUID();
    const now = Date.now();
    const shortIdBig =
      typeof sign.conversationShortId === 'bigint'
        ? sign.conversationShortId
        : BigInt(sign.conversationShortId);
    const conversationType = sign.conversationType ?? 1;
    const messageType = 7;
    const ticket = sign.ticket || '';

    // 1. 获取 identity_security_token
    const tokenResult = await this.getIdentitySecurityToken();
    if (!tokenResult) {
      return {
        success: false,
        msgId: clientMessageId,
        reason: '获取 identity_security_token 失败',
      };
    }

    // 2. 构造 protobuf body
    // content JSON（与原 sendMessage 一致）
    const content = JSON.stringify({
      aweType: 700,
      type: 0,
      richTextInfos: [],
      text,
    });

    // ext map 条目（按抓包样本顺序）
    const extEntries: Array<[string, string]> = [
      ['s:mentioned_users', ''],
      ['s:client_message_id', clientMessageId],
      [
        'a:chat_bubble',
        JSON.stringify({ bubble_id: '7662684283743536666', bubble_source: '1' }),
      ],
      ['s:stime', `${now}.5`],
    ];

    const bodyType = 100; // cmd=100 (SEND_MESSAGE) → body_type=100
    const parts: Buffer[] = [
      encodeStringField(1, conversationId),
      encodeVarintField(2, conversationType),
      encodeVarintField(3, shortIdBig),
      encodeStringField(4, content),
      ...extEntries.map(([k, v]) => {
        const entry = Buffer.concat([
          encodeStringField(1, k),
          encodeStringField(2, v),
        ]);
        return encodeBytesField(5, entry);
      }),
      encodeVarintField(6, messageType),
      encodeStringField(7, ticket),
      encodeStringField(8, clientMessageId),
    ];
    const subBody = Buffer.concat(parts);
    const body = encodeBytesField(bodyType, subBody);

    // 关键修复：identity_security_token 需 JSON 包装为 {"token":"<raw>"}
    // 对比抓包 body hex 中 identity_security_token 字段值为 {"token":"Cj3cPr0q..."}
    const reqEnv: RequestEnv = {
      ...env,
      identitySecurityToken: JSON.stringify({ token: tokenResult.token }),
      identitySecurityDeviceId: tokenResult.deviceId,
      identitySecurityAid: '',
    };

    const reqBuf = buildRequest({
      cmd: IMAPI_CONSTANTS.IMCMD.SEND_MESSAGE,
      sequenceId: nextBrowserSeq(),
      inboxType: 0,
      body,
      env: reqEnv,
    });

    log.info(
      `BrowserSender: 发送消息 (${reqBuf.length} 字节) text=${JSON.stringify(text.slice(0, 50))}`,
    );

    return await this._postAndParse(reqBuf, bodyType, clientMessageId);
  }

  /**
   * 发送引用回复消息（自动签名）
   *
   * 与 send 的区别：
   *   - content JSON 使用 aweType=703（引用回复）
   *   - body 额外添加 field 11（refmsg 引用元数据）
   *
   * @param env 请求环境（含 cookie）
   * @param conversationId 会话 ID
   * @param text 回复文本
   * @param ref 被引用消息信息
   * @param sign 会话签名信息
   */
  async sendQuoteReply(
    env: RequestEnv,
    conversationId: string,
    text: string,
    ref: QuoteReplyRef,
    sign: BrowserSendSign,
  ): Promise<BrowserSendResult> {
    if (!this.page) {
      return { success: false, reason: '浏览器未启动，请先调用 launch()' };
    }

    const clientMessageId = randomUUID();
    const now = Date.now();
    const shortIdBig =
      typeof sign.conversationShortId === 'bigint'
        ? sign.conversationShortId
        : BigInt(sign.conversationShortId);
    const conversationType = sign.conversationType ?? 1;
    const messageType = 7;
    const ticket = sign.ticket || '';

    // 1. 获取 identity_security_token
    const tokenResult = await this.getIdentitySecurityToken();
    if (!tokenResult) {
      return {
        success: false,
        msgId: clientMessageId,
        reason: '获取 identity_security_token 失败',
      };
    }

    // 2. 构造 protobuf body（引用回复，aweType=703）
    const content = JSON.stringify({
      aweType: 703,
      type: 0,
      richTextInfos: [],
      text,
    });

    const extEntries: Array<[string, string]> = [
      ['s:mentioned_users', ''],
      ['s:client_message_id', clientMessageId],
      [
        'a:chat_bubble',
        JSON.stringify({ bubble_id: '7662684283743536666', bubble_source: '1' }),
      ],
      ['s:stime', `${now}.5`],
    ];

    // 引用回复特有的 field 11（refmsg 引用元数据）
    const refExtEntries: Array<[string, string]> = [
      ['s:ref_content', ref.refmsgContent],
      ['s:ref_is_edited', 'false'],
    ];
    const refmsgMeta = JSON.stringify({
      refmsg_type: ref.refmsgType,
      content: ref.refmsgShortText,
      refmsg_uid: ref.refmsgUid,
      refmsg_sec_uid: ref.refmsgSecUid,
      nickname: ref.refmsgNickname,
      refmsg_content: ref.refmsgContent,
      version: 1,
      itemId: '',
      scene_type: 1,
    });
    const refServerIdBig = BigInt(ref.serverMsgId);
    const refmsgField11 = Buffer.concat([
      encodeVarintField(1, refServerIdBig),
      encodeStringField(2, refmsgMeta),
      encodeVarintField(3, refServerIdBig),
      ...refExtEntries.map(([k, v]) => {
        const entry = Buffer.concat([encodeStringField(1, k), encodeStringField(2, v)]);
        return encodeBytesField(5, entry);
      }),
    ]);

    const bodyType = 100;
    const parts: Buffer[] = [
      encodeStringField(1, conversationId),
      encodeVarintField(2, conversationType),
      encodeVarintField(3, shortIdBig),
      encodeStringField(4, content),
      ...extEntries.map(([k, v]) => {
        const entry = Buffer.concat([
          encodeStringField(1, k),
          encodeStringField(2, v),
        ]);
        return encodeBytesField(5, entry);
      }),
      encodeVarintField(6, messageType),
      encodeStringField(7, ticket),
      encodeStringField(8, clientMessageId),
      encodeBytesField(11, refmsgField11), // 引用回复特有
    ];
    const subBody = Buffer.concat(parts);
    const body = encodeBytesField(bodyType, subBody);

    const reqEnv: RequestEnv = {
      ...env,
      identitySecurityToken: JSON.stringify({ token: tokenResult.token }),
      identitySecurityDeviceId: tokenResult.deviceId,
      identitySecurityAid: '',
    };

    const reqBuf = buildRequest({
      cmd: IMAPI_CONSTANTS.IMCMD.SEND_MESSAGE,
      sequenceId: nextBrowserSeq(),
      inboxType: 0,
      body,
      env: reqEnv,
    });

    log.info(
      `BrowserSender: 发送引用回复 (${reqBuf.length} 字节) text=${JSON.stringify(text.slice(0, 50))} refMsgId=${ref.serverMsgId}`,
    );

    return await this._postAndParse(reqBuf, bodyType, clientMessageId);
  }

  /**
   * 通过浏览器页面发送 protobuf 请求并解析响应（内部复用）
   *
   * secsdk 自动注入 a_bogus/msToken/bd-ticket-guard-* 等签名。
   */
  private async _postAndParse(
    reqBuf: Buffer,
    bodyType: number,
    clientMessageId: string,
  ): Promise<BrowserSendResult> {
    if (!this.page) {
      return { success: false, reason: '浏览器未启动' };
    }

    const bodyBase64 = reqBuf.toString('base64');

    const fetchResult = await this.page.evaluate(async (base64: string) => {
      try {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const res = await fetch('https://imapi.douyin.com/v1/message/send', {
          method: 'POST',
          headers: { 'content-type': 'application/x-protobuf' },
          body: bytes,
          credentials: 'include',
        });
        const respBuf = new Uint8Array(await res.arrayBuffer());
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < respBuf.length; i += chunk) {
          binary += String.fromCharCode.apply(
            null,
            Array.from(respBuf.subarray(i, i + chunk)) as unknown as number[],
          );
        }
        return {
          ok: true as const,
          status: res.status,
          respBase64: btoa(binary),
          respSize: respBuf.length,
        };
      } catch (e) {
        return { ok: false as const, reason: String(e) };
      }
    }, bodyBase64);

    if (!fetchResult.ok) {
      return {
        success: false,
        msgId: clientMessageId,
        reason: `fetch 失败: ${fetchResult.reason}`,
      };
    }

    log.info(
      `BrowserSender: 响应 status=${fetchResult.status} size=${fetchResult.respSize}`,
    );

    const respBuf = Buffer.from(fetchResult.respBase64, 'base64');
    const resp = parseResponse(respBuf);

    if (resp.statusCode !== 0) {
      return {
        success: false,
        msgId: clientMessageId,
        reason: `status=${resp.statusCode} desc=${resp.errorDesc}`,
      };
    }

    const bodyFields = parseFields(resp.body);
    const subField = findField(bodyFields, bodyType);
    if (!subField) {
      return {
        success: false,
        msgId: clientMessageId,
        reason: `响应 body 中未找到 sub-field ${bodyType}`,
      };
    }
    const subFields = readMessage(subField);
    const serverIdBig = findField(subFields, 1)
      ? readVarintBigint(findField(subFields, 1)!)
      : 0n;
    const status = findField(subFields, 3)
      ? readVarint(findField(subFields, 3)!)
      : -1;
    const respClientId = findField(subFields, 4)
      ? readString(findField(subFields, 4)!)
      : clientMessageId;

    if (status === 0 && serverIdBig > 0n) {
      log.info(`BrowserSender: 发送成功 serverMsgId=${serverIdBig}`);
      return {
        success: true,
        msgId: respClientId,
        serverMsgId: serverIdBig.toString(),
      };
    }
    return {
      success: false,
      msgId: respClientId,
      reason: `business status=${status} serverId=${serverIdBig}`,
    };
  }

  /** 关闭浏览器 */
  async close(): Promise<void> {
    try {
      await this.context?.close();
    } catch {}
    try {
      await this.browser?.close();
    } catch {}
    this.page = null;
    this.context = null;
    this.browser = null;
    this.cachedToken = null;
    log.info('BrowserSender: 浏览器已关闭');
  }
}

/**
 * 一次性浏览器发送（用于 send 命令）
 *
 * 启动浏览器 → 发送消息 → 关闭浏览器
 *
 * @param storageStatePath storageState 文件路径
 * @param env 请求环境
 * @param conversationId 会话 ID
 * @param text 文本内容
 * @param sign 会话签名信息
 * @param headless 是否无头模式（默认 true）
 */
export async function sendViaBrowser(
  storageStatePath: string,
  env: RequestEnv,
  conversationId: string,
  text: string,
  sign: BrowserSendSign,
  headless = true,
): Promise<BrowserSendResult> {
  const sender = new BrowserSender(storageStatePath, headless);
  try {
    await sender.launch();
    return await sender.send(env, conversationId, text, sign);
  } catch (e) {
    return {
      success: false,
      reason: `browser-send 异常: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    await sender.close();
  }
}

/**
 * 一次性浏览器引用回复（用于 reply 命令）
 *
 * 启动浏览器 → 发送引用回复 → 关闭浏览器
 */
export async function sendQuoteReplyViaBrowser(
  storageStatePath: string,
  env: RequestEnv,
  conversationId: string,
  text: string,
  ref: QuoteReplyRef,
  sign: BrowserSendSign,
  headless = true,
): Promise<BrowserSendResult> {
  const sender = new BrowserSender(storageStatePath, headless);
  try {
    await sender.launch();
    return await sender.sendQuoteReply(env, conversationId, text, ref, sign);
  } catch (e) {
    return {
      success: false,
      reason: `browser-send 异常: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    await sender.close();
  }
}
