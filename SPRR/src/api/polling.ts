/**
 * HTTP 轮询消息同步（cmd 2043 init / cmd 2048 poll）
 *
 * 2026-08 起，抖音 Web IM 将 Frontier WebSocket 长连接迁移至 HTTP 短轮询
 * （抓包证实聊天页全程 0 个 WS 连接，见 data/capture/debug/）：
 *   - cmd=2043  POST /v1/message/get_message_by_init   初始化同步，返回初始游标
 *   - cmd=2048  POST /v1/message/get_user_message      轮询新消息与会话事件
 *
 * 协议结构（2026-08-25 / 09-07 抓包逆向）：
 *   Request body = { <cmd编号>: <payload> }（用 cmd 编号作为字段号包裹）
 *     cmd2043 payload: 首次 {2:0}；增量续传 {1:<上次游标µs>, 2:1}
 *     cmd2048 payload: {1:<消息游标µs>, 2:<收件箱序号>, 4:<辅助时间戳µs>, 5:"cursor"}
 *   Response body = { <cmd编号>: {
 *     1: { 1:<下一消息游标µs>, 2:{1:short_id, 2:MessageBody, 5:cid, 22:readindex} },  // 新消息（可重复）
 *     2: { 1:{1:cid, 6:事件类型, 8:payload JSON, ...}, 3:<下一收件箱序号> },          // 会话事件（已读回执等）
 *   }}
 *   空轮询响应约 170B，事件响应约 850B，消息响应更大。
 *
 * imapi 接口仅需 Cookie（无 a_bogus/msToken/bd-ticket-guard），纯 Node 可直连。
 *
 * 游标维护策略（与官方客户端观察行为对齐）：
 *   - inboxSeq：权威游标，每次响应取 f2.f3 回传值（服务端已推进则跟随）
 *   - messageCursorUs：取响应 f1.f1 非零值；未推进时保持原值
 *   - auxTsUs：每次轮询取当前时间 µs（稳态下官方客户端行为）
 *   - 上游可能重复下发旧消息，调用方须按 serverMsgId 去重兜底
 */

import {
  encodeVarintField,
  encodeBytesField,
  parseFields,
  findField,
  findFields,
  readMessage,
  readString,
  WireType,
} from '../crypto/protobuf.js';
import {
  buildRequest,
  sendImapi,
  type RequestEnv,
} from './imapi.js';
import { nextSeq, parseMessageBody, type MessageItem } from './operations.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('polling');

/** cmd 编号（2026-08 新增，尚未列入 IMAPI_CONSTANTS.IMCMD） */
export const POLL_CMD = {
  GET_MESSAGE_BY_INIT: 2043,
  GET_USER_MESSAGE: 2048,
} as const;

export const POLL_PATH_INIT = '/v1/message/get_message_by_init';
export const POLL_PATH_POLL = '/v1/message/get_user_message';

/** 同步游标（cmd 2048 请求 payload 输入） */
export interface PollCursors {
  /** field 1: 消息同步游标（微秒时间戳） */
  messageCursorUs: bigint;
  /** field 2: 收件箱事件序号（权威去重游标） */
  inboxSeq: bigint;
  /** field 4: 辅助时间戳（微秒） */
  auxTsUs: bigint;
}

/** 轮询收到的新消息 */
export interface PollMessage {
  /** 会话 ID（如 "0:1:<uidA>:<uidB>"） */
  conversationId: string;
  /** 消息（标准 MessageBody 解析结果，与 cmd301 一致） */
  message: MessageItem;
}

/** 轮询收到的会话事件（已读回执等，非消息本体） */
export interface PollEvent {
  conversationId: string;
  /** 事件类型（如 50001=已读回执更新） */
  eventType: number;
  /** 事件 payload JSON（如 read_index 信息） */
  payloadJson?: string;
  /** 事件时间（毫秒） */
  tsMs?: number;
}

export interface PollResult {
  messages: PollMessage[];
  events: PollEvent[];
  /** 用于下一轮轮询的游标 */
  next: PollCursors;
}

/** 当前时间微秒 */
function nowUs(): bigint {
  return BigInt(Date.now()) * 1000n;
}

/** 构造 cmd2043 init body：首次 {2:0}，增量续传 {1:<cursor>, 2:1} */
export function buildInitBody(incrementalCursorUs?: bigint): Buffer {
  const payload =
    incrementalCursorUs !== undefined
      ? Buffer.concat([
          encodeVarintField(1, incrementalCursorUs),
          encodeVarintField(2, 1),
        ])
      : encodeVarintField(2, 0);
  return encodeBytesField(POLL_CMD.GET_MESSAGE_BY_INIT, payload);
}

/** 构造 cmd2048 poll body：{1:cursor, 2:seq, 4:ts, 5:"cursor"} */
export function buildPollBody(c: PollCursors, cursorTag = 'cursor'): Buffer {
  const payload = Buffer.concat([
    encodeVarintField(1, c.messageCursorUs),
    encodeVarintField(2, c.inboxSeq),
    encodeVarintField(4, c.auxTsUs),
    encodeBytesField(5, Buffer.from(cursorTag, 'utf-8')),
  ]);
  return encodeBytesField(POLL_CMD.GET_USER_MESSAGE, payload);
}

/**
 * 初始化消息同步（cmd 2043）
 *
 * 首次调用（不带参数）返回全量快照 + 初始游标。
 * 响应 body.f2043：{4: 消息游标µs, 5: 消息游标µs(副本), 6: 收件箱序号, 7: 辅助时间戳µs}
 */
export async function initMessageSync(
  env: RequestEnv,
  incrementalCursorUs?: bigint,
): Promise<PollCursors> {
  const reqBuf = buildRequest({
    cmd: POLL_CMD.GET_MESSAGE_BY_INIT,
    sequenceId: nextSeq(),
    // 官方客户端 init/poll 请求均带 inbox_type=1（抓包证实，含义为全量收件箱）
    inboxType: 1,
    body: buildInitBody(incrementalCursorUs),
    env,
  });

  const resp = await sendImapi({
    path: POLL_PATH_INIT,
    body: reqBuf,
    cookie: env.cookie,
    timeoutMs: 20_000,
  });
  if (resp.statusCode !== 0) {
    throw new Error(`init 失败 status=${resp.statusCode} desc=${resp.errorDesc} logId=${resp.logId}`);
  }

  const bodyFields = parseFields(resp.body);
  const sub = findField(bodyFields, POLL_CMD.GET_MESSAGE_BY_INIT);
  if (!sub || sub.wire !== WireType.LengthDelimited) {
    throw new Error('init 响应 body 中未找到 sub-field 2043');
  }
  const s = readMessage(sub);

  const readVar = (n: number): bigint | undefined => {
    const f = findField(s, n);
    return f && f.wire === WireType.Varint ? (f.value as bigint) : undefined;
  };
  // f4/f5 均为消息游标（抓包中值相同），优先 f5（与响应 f1.f1 推进值同源）
  const messageCursorUs = readVar(5) ?? readVar(4) ?? nowUs();
  const inboxSeq = readVar(6) ?? 0n;
  const auxTsUs = readVar(7) ?? nowUs();

  const cursors: PollCursors = { messageCursorUs, inboxSeq, auxTsUs };
  log.info(
    `initMessageSync: msgCursor=${messageCursorUs} inboxSeq=${inboxSeq} auxTs=${auxTsUs}`,
  );
  return cursors;
}

/**
 * 解析 cmd2048 响应 body（纯函数，便于离线校验）
 *
 * next 在传入 cursors 基础上按响应推进：
 *   - messageCursorUs ← 更新节点 f1（非零时）
 *   - inboxSeq ← 事件节点 f3（非零时）
 *   - auxTsUs ← 当前时间
 */
export function parsePollResponse(
  bodyBuf: Buffer,
  cursors: PollCursors,
  myUid?: string,
): PollResult {
  const next: PollCursors = { ...cursors, auxTsUs: nowUs() };
  const messages: PollMessage[] = [];
  const events: PollEvent[] = [];

  const bodyFields = parseFields(bodyBuf);
  const sub = findField(bodyFields, POLL_CMD.GET_USER_MESSAGE);
  if (!sub || sub.wire !== WireType.LengthDelimited) {
    return { messages, events, next };
  }
  const s = readMessage(sub);

  // field 1（可重复）：新消息更新节点 {1: 下一游标, 2: 消息包裹}
  for (const upd of findFields(s, 1)) {
    if (upd.wire !== WireType.LengthDelimited) continue;
    const uf = readMessage(upd);

    const cursorField = findField(uf, 1);
    if (
      cursorField &&
      cursorField.wire === WireType.Varint &&
      (cursorField.value as bigint) !== 0n
    ) {
      next.messageCursorUs = cursorField.value as bigint;
    }

    // 消息包裹 {1: short_id string, 2: MessageBody, 5: cid string}
    const wrap = findField(uf, 2);
    if (!wrap || wrap.wire !== WireType.LengthDelimited) continue;
    const wf = readMessage(wrap);
    const cidField = findField(wf, 5);
    const cid = cidField && cidField.wire === WireType.LengthDelimited ? readString(cidField) : '';
    const msgField = findField(wf, 2);
    if (!msgField || msgField.wire !== WireType.LengthDelimited) continue;
    const item = parseMessageBody(msgField, cid, myUid);
    if (item) {
      messages.push({ conversationId: cid || item.conversationId, message: item });
    }
  }

  // field 2：会话事件节点 {1: 事件(可重复), 3: 下一收件箱序号}
  const evNode = findField(s, 2);
  if (evNode && evNode.wire === WireType.LengthDelimited) {
    const ef = readMessage(evNode);
    const seqField = findField(ef, 3);
    if (
      seqField &&
      seqField.wire === WireType.Varint &&
      (seqField.value as bigint) !== 0n
    ) {
      next.inboxSeq = seqField.value as bigint;
    }
    for (const rec of findFields(ef, 1)) {
      if (rec.wire !== WireType.LengthDelimited) continue;
      try {
        const rf = readMessage(rec);
        const evCidField = findField(rf, 1);
        const cid =
          evCidField && evCidField.wire === WireType.LengthDelimited ? readString(evCidField) : '';
        const evTypeField = findField(rf, 6);
        const payloadField = findField(rf, 8);
        const tsField = findField(rf, 10);
        events.push({
          conversationId: cid,
          eventType: evTypeField && evTypeField.wire === WireType.Varint ? Number(evTypeField.value as bigint) : 0,
          payloadJson: payloadField && payloadField.wire === WireType.LengthDelimited ? readString(payloadField) : undefined,
          tsMs: tsField && tsField.wire === WireType.Varint ? Number(tsField.value as bigint) : undefined,
        });
      } catch (e) {
        log.debug(`事件解析失败: ${e}`);
      }
    }
  }

  return { messages, events, next };
}

/**
 * 轮询一次（cmd 2048）
 *
 * 返回本轮收到的新消息 / 会话事件，以及用于下一轮的游标。
 * 空轮询返回空数组；响应异常抛出由调用方决定重试/重建。
 */
export async function pollUserMessage(
  env: RequestEnv,
  cursors: PollCursors,
  myUid?: string,
): Promise<PollResult> {
  const reqBuf = buildRequest({
    cmd: POLL_CMD.GET_USER_MESSAGE,
    sequenceId: nextSeq(),
    inboxType: 1,
    body: buildPollBody(cursors),
    env,
  });

  const resp = await sendImapi({
    path: POLL_PATH_POLL,
    body: reqBuf,
    cookie: env.cookie,
    timeoutMs: 20_000,
  });
  if (resp.statusCode !== 0) {
    throw new Error(`poll 失败 status=${resp.statusCode} desc=${resp.errorDesc} logId=${resp.logId}`);
  }

  const result = parsePollResponse(resp.body, cursors, myUid);
  log.debug(
    `pollUserMessage: msgs=${result.messages.length} events=${result.events.length} next(seq=${result.next.inboxSeq}, cursor=${result.next.messageCursorUs})`,
  );
  return result;
}
