/**
 * 抖音 IM 实时消息推送（WebSocket Frontier）
 *
 * 抖音通过 wss://frontier-im.douyin.com/ws/v2 实时推送消息通知。
 *
 * 连接流程：
 *   1. 客户端生成 access_key（由 webmssdk.es5.js 的 frontierSign 函数本地生成，VM 保护）
 *   2. 拼接 WS URL：wss://frontier-im.douyin.com/ws/v2?aid=6383&fpid=9&device_id=<UID>&access_key=<key>&...
 *   3. 建立 WebSocket 连接（必须带 Cookie header，否则服务器不推送）
 *   4. 客户端定期发送 2 字节心跳 "hi"（0x6869）
 *   5. 服务器推送完整消息内容（protobuf 帧，含 conversation_id + 消息正文）
 *
 * access_key 获取：
 *   - frontierSign 是 VM 字节码保护的函数，无法在纯 Node.js 中复现
 *   - 通过 Playwright 启动浏览器、拦截 WS 连接来提取 access_key（见 extract-ws-key.ts）
 *   - 提取后可关闭浏览器，Node.js 带 Cookie 直连即可（access_key 不与浏览器会话绑定）
 *
 * Frontier WS 帧结构（protobuf）：
 *   field 1  (varint): 服务器时间戳（秒）
 *   field 2  (varint): 内部消息 ID（int64）
 *   field 3  (varint): cmd 类型（通常 5）
 *   field 4  (varint): 通常 1
 *   field 5  (repeated message): ext 条目（x_frontier_received_time / x_frontier_msg_id 等）
 *   field 6  (bytes): 小字段（2 字节）
 *   field 7  (message): 编码类型信息（含 field 14 = varint 98 = "b"）
 *   field 8  (bytes): payload（嵌套 protobuf，非 JSON！）
 *   field 9  (string): msg_id（如 "msg_dk6qy0nwn3oy00009r4e35qob7du"）
 *   field 11 (string): msg_id（同 field 9）
 *
 * payload（field 8）嵌套 protobuf 结构：
 *   field 1 (varint): 消息类型代码（500=新消息, 其他=会话更新）
 *   field 2 (varint): 0
 *   field 3 (varint): 0
 *   field 5 (varint): 消息方向（1=发送, 2=接收）
 *   field 6 (bytes): ConversationInfo（嵌套 protobuf，含完整消息内容）
 *   field 7 (string): log_id
 *
 * ConversationInfo（field 8.f6）结构：
 *   field 500 (message): 嵌套 conversation 数据
 *     field 2 (string): conversation_id "0:1:<myUid>:<peerUid>"
 *     field 8 (string): content JSON（如 {"aweType":700,"text":"hello"}）
 *     field 16 (varint): sender uid
 *     field 20 (bytes): sender sec_uid
 *     field 24 (varint): 1
 *     field 26 (bytes): 消息体
 *     field 42 (bytes, repeated): ext 条目
 *
 * 重要：推送帧包含完整消息内容，无需再调 getHistory 拉取！
 */

import { createLogger } from '../utils/logger.js';
import {
  parseFields,
  findField,
  findFields,
  readVarint,
  readVarintBigint,
  readVarintString,
  readString,
  readMessage,
  type ProtobufField,
} from '../crypto/protobuf.js';

const log = createLogger('frontier');

/** Frontier WS 帧解析结果 */
export interface FrontierFrame {
  /** 服务器时间戳（秒） */
  serverTimestamp?: number;
  /** 内部消息 ID（int64，字符串形式避免精度丢失） */
  internalMsgId?: string;
  /** msg_id（如 "msg_dk6qy0nwn3oy00009r4e35qob7du"） */
  msgId?: string;
  /** payload 解析结果（field 8 嵌套 protobuf） */
  payload?: FrontierPayload;
  /** 原始 payload 字符串（field 8 的 utf-8 解码，含可读 JSON 片段） */
  payloadRaw?: string;
}

/** payload（field 8）解析结果 */
export interface FrontierPayload {
  /** 消息类型代码（500=新消息，其他=会话更新） */
  msgType?: number;
  /** 消息方向（1=自己发送, 2=对方发送）—— 注意：此字段并不可靠，
   *  实测对方消息也可能 direction=1。判断发送者请用 senderUid === myUid */
  direction?: number;
  /** 发送者 uid（从 ConversationInfo field 16 解析，int64 字符串形式）
   *  这是判断消息方向的可靠依据：senderUid === myUid 表示自己发送 */
  senderUid?: string;
  /** 会话 ID "0:1:<myUid>:<peerUid>" */
  conversationId?: string;
  /** log_id */
  logId?: string;
  /** 消息内容 JSON 字符串（从 ConversationInfo 中提取） */
  contentJson?: string;
  /** 消息文本（从 contentJson 中提取） */
  text?: string;
  /** aweType（从 contentJson 中提取） */
  aweType?: number;
}

/** 解析 Frontier WS 二进制帧 */
export function parseFrontierFrame(buf: Buffer): FrontierFrame {
  const fields = parseFields(buf);
  const result: FrontierFrame = {};

  // field 1: 服务器时间戳
  const f1 = findField(fields, 1);
  if (f1) result.serverTimestamp = readVarint(f1);

  // field 2: 内部消息 ID（int64）
  const f2 = findField(fields, 2);
  if (f2) result.internalMsgId = readVarintBigint(f2).toString();

  // field 9 或 11: msg_id
  const f9 = findField(fields, 9);
  if (f9) result.msgId = readString(f9);
  if (!result.msgId) {
    const f11 = findField(fields, 11);
    if (f11) result.msgId = readString(f11);
  }

  // field 8: payload（嵌套 protobuf）
  const f8 = findField(fields, 8);
  if (f8 && f8.wire === 2) {
    const payloadBuf = f8.value as Buffer;
    result.payloadRaw = payloadBuf.toString('utf-8');
    result.payload = parsePayload(payloadBuf);
  }

  return result;
}

/** 解析 field 8 payload（嵌套 protobuf） */
function parsePayload(buf: Buffer): FrontierPayload {
  const result: FrontierPayload = {};
  const fields = parseFields(buf);

  // field 1: 消息类型代码（500=新消息）
  const f1 = findField(fields, 1);
  if (f1) result.msgType = readVarint(f1);

  // field 5: 消息方向（1=发送, 2=接收）
  const f5 = findField(fields, 5);
  if (f5) result.direction = readVarint(f5);

  // field 7: log_id
  const f7 = findField(fields, 7);
  if (f7) result.logId = readString(f7);

  // field 6: ConversationInfo（嵌套 protobuf，含消息内容）
  const f6 = findField(fields, 6);
  if (f6 && f6.wire === 2) {
    const convBuf = f6.value as Buffer;
    parseConversationInfo(convBuf, result);
  }

  return result;
}

/** 解析 ConversationInfo（field 8.f6），提取 conversation_id 和消息内容
 *
 * 实际结构：ConversationInfo 内部有一个 field 500 嵌套 message，
 * 其中包含 field 2（conversation_id）和 field 8（content JSON）等字段。
 */
function parseConversationInfo(buf: Buffer, result: FrontierPayload): void {
  const fields = parseFields(buf);

  // conversation 数据嵌套在 field 500 内部
  let convFields = fields;
  const f500 = findField(fields, 500);
  if (f500 && f500.wire === 2) {
    convFields = parseFields(f500.value as Buffer);
  }

  // field 2: conversation_id "0:1:<myUid>:<peerUid>"
  const f2 = findField(convFields, 2);
  if (f2) result.conversationId = readString(f2);

  // field 16: sender uid（int64，用 readVarintString 避免精度丢失）
  // 这是判断消息方向的可靠依据（direction 字段并不可靠）
  const f16 = findField(convFields, 16);
  if (f16) result.senderUid = readVarintString(f16);

  // field 8: content JSON（如 {"aweType":700,"text":"hello"}）
  const f8 = findField(convFields, 8);
  if (f8 && f8.wire === 2) {
    const jsonStr = readString(f8);
    try {
      const obj = JSON.parse(jsonStr);
      result.contentJson = jsonStr;
      if (obj.text) result.text = obj.text;
      if (obj.aweType !== undefined) result.aweType = obj.aweType;
      return;
    } catch {
      // 非合法 JSON，回退到正则搜索
    }
  }

  // 回退：遍历所有 length-delimited 字段查找 JSON 内容
  for (const f of convFields) {
    if (f.wire !== 2) continue;
    const v = f.value as Buffer;
    const str = v.toString('utf-8');
    const jsonMatch = str.match(/\{"(aweType|type|instruction_type)"[^}]*\}/);
    if (jsonMatch) {
      result.contentJson = jsonMatch[0];
      try {
        const obj = JSON.parse(jsonMatch[0]);
        if (obj.text) result.text = obj.text;
        if (obj.aweType !== undefined) result.aweType = obj.aweType;
      } catch {
        // 忽略 JSON 解析错误
      }
      break;
    }
  }
}

/** 心跳包内容（protobuf field 13 = varint 105，即 2 字节 "hi"） */
const HEARTBEAT = Buffer.from([0x68, 0x69]); // "hi"

/** 心跳间隔（毫秒）。抖音服务器约 60 秒不活动会断开，10 秒比较安全 */
const HEARTBEAT_INTERVAL_MS = 10_000;

/** 自动重连间隔（毫秒） */
const RECONNECT_INTERVAL_MS = 2_000;

/** 最大重连间隔（毫秒，指数退避上限） */
const RECONNECT_MAX_MS = 30_000;

/** 连接选项 */
export interface FrontierConnectOptions {
  /** access_key（32 位十六进制，由 frontierSign 生成） */
  accessKey: string;
  /** device_id（即用户 UID） */
  deviceId: string;
  /** 收到帧时的回调 */
  onFrame: (frame: FrontierFrame) => void;
  /** 连接成功回调（每次重连成功都会触发） */
  onOpen?: () => void;
  /** 连接关闭回调（仅在主动 close 或重连失败时触发，正常重连不会触发） */
  onClose?: (code: number, reason: string) => void;
  /** 连接错误回调 */
  onError?: (err: unknown) => void;
  /** 重连开始回调 */
  onReconnect?: (attempt: number, delayMs: number) => void;
  /** aid 参数（默认 6383） */
  aid?: string;
  /** fpid 参数（默认 9） */
  fpid?: string;
  /** device_platform（默认 douyin_pc） */
  devicePlatform?: string;
  /** version_code（默认 360000） */
  versionCode?: string;
  /** Cookie 字符串（浏览器建立 WS 时会自动带 Cookie，服务器用于身份校验） */
  cookie?: string;
  /** 是否启用自动重连（默认 true） */
  autoReconnect?: boolean;
}

/**
 * 连接到 Frontier WebSocket 并监听实时消息推送
 *
 * 内置自动重连机制：连接断开（code 1006 等）后会指数退避重连。
 *
 * 返回一个 close() 函数用于主动断开连接（不会触发重连）。
 */
export function connectFrontier(opts: FrontierConnectOptions): {
  close: () => void;
} {
  const {
    accessKey,
    deviceId,
    onFrame,
    onOpen,
    onClose,
    onError,
    onReconnect,
    aid = '6383',
    fpid = '9',
    devicePlatform = 'douyin_pc',
    versionCode = '360000',
    cookie,
    autoReconnect = true,
  } = opts;

  let userClosed = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let currentWs: WebSocket | null = null;

  const wsUrl = `wss://frontier-im.douyin.com/ws/v2?aid=${aid}&fpid=${fpid}&device_id=${deviceId}&access_key=${accessKey}&device_platform=${devicePlatform}&version_code=${versionCode}`;

  // Node.js 22 的全局 WebSocket（基于 undici）支持 options.headers
  // 浏览器建立 WS 连接时会自动发送 Origin / User-Agent / Cookie，抖音服务器会校验
  // 缺少 Cookie 会导致：握手成功但服务器不推送消息，30秒后断开连接
  const buildHeaders = (): Record<string, string> => {
    const h: Record<string, string> = {
      Origin: 'https://www.douyin.com',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    };
    if (cookie) {
      h['Cookie'] = cookie;
    }
    return h;
  };

  const connectOnce = (): void => {
    if (userClosed) return;
    if (reconnectAttempt === 0) {
      log.info(`connectFrontier: 连接 ${wsUrl.replace(accessKey, '<redacted>')}`);
    } else {
      log.info(`connectFrontier: 第 ${reconnectAttempt} 次重连...`);
    }

    // Node.js 内置 WebSocket（undici）支持 options.headers，但 TS lib.dom.d.ts
    // 只声明了 protocols: string | string[]，故需要 as any 传入 headers
    const ws = new WebSocket(wsUrl, { headers: buildHeaders() } as unknown as string[]);
    currentWs = ws;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    const stopHeartbeat = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      if (reconnectAttempt > 0) {
        log.info(`connectFrontier: 第 ${reconnectAttempt} 次重连成功`);
      } else {
        log.info('connectFrontier: WebSocket 已连接');
      }
      reconnectAttempt = 0;
      // 启动心跳
      heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(HEARTBEAT);
          log.debug('connectFrontier: 发送心跳');
        }
      }, HEARTBEAT_INTERVAL_MS);
      onOpen?.();
    };

    ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        const buf = Buffer.from(event.data);
        try {
          const frame = parseFrontierFrame(buf);
          onFrame(frame);
        } catch (e) {
          log.warn('connectFrontier: 帧解析失败', e);
        }
      } else if (event.data instanceof Buffer) {
        try {
          const frame = parseFrontierFrame(event.data);
          onFrame(frame);
        } catch (e) {
          log.warn('connectFrontier: 帧解析失败', e);
        }
      } else {
        log.debug(`connectFrontier: 收到非二进制消息 (${typeof event.data})`);
      }
    };

    ws.onerror = (event: Event) => {
      log.error('connectFrontier: WebSocket 错误', event);
      onError?.(event);
    };

    ws.onclose = (event: CloseEvent) => {
      stopHeartbeat();
      currentWs = null;
      log.info(`connectFrontier: WebSocket 关闭 code=${event.code} reason=${event.reason}`);

      if (userClosed) {
        // 用户主动关闭，不重连
        onClose?.(event.code, event.reason);
        return;
      }

      if (!autoReconnect) {
        onClose?.(event.code, event.reason);
        return;
      }

      // 自动重连（指数退避）
      reconnectAttempt += 1;
      const delay = Math.min(
        RECONNECT_INTERVAL_MS * Math.pow(1.5, reconnectAttempt - 1),
        RECONNECT_MAX_MS,
      );
      log.warn(`connectFrontier: ${delay}ms 后重连（第 ${reconnectAttempt} 次）`);
      onReconnect?.(reconnectAttempt, delay);
      reconnectTimer = setTimeout(connectOnce, delay);
    };
  };

  connectOnce();

  return {
    close: () => {
      if (userClosed) return;
      userClosed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (currentWs) {
        try {
          currentWs.close(1000, 'client close');
        } catch {
          // 忽略关闭错误
        }
      }
    },
  };
}
