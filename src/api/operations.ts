/**
 * 抖音 IM API 业务操作（纯 Node.js HTTP + protobuf）
 *
 * 三大功能：
 *   1. listContacts  - 列出所有会话/联系人
 *   2. getHistory    - 获取指定会话的历史消息
 *   3. sendMessage   - 发送文本消息（需要 4 层签名，见 signature.ts）
 *
 * 协议说明（基于 data/send-flow.json 与抓包样本逆向）：
 *   - 请求 body (field 8) 内嵌一个 sub-message，sub-field 号 = cmd 对应的 body_type
 *     cmd=100  -> body_type=100  (send_message)
 *     cmd=301  -> body_type=301  (get_by_conversation)
 *     cmd=610  -> body_type=610  (get_info_list)
 *     cmd=1001 -> body_type=1000 (stranger_get_conversation_list)
 *   - 响应 body (field 6) 内嵌同结构 sub-message
 *
 * 签名需求：
 *   - list/history：仅需 Cookie，无需 a_bogus/msToken/bd-ticket-guard 签名
 *   - send：需要 a_bogus + msToken + bd-ticket-guard(5个头) + identity_security_token
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../utils/logger.js';
import {
  IMAPI_CONSTANTS,
  buildRequest,
  sendImapi,
  parseResponse,
  type RequestEnv,
  type ImapiResponse,
} from './imapi.js';
import {
  encodeVarintField,
  encodeStringField,
  encodeBytesField,
  encodeMapEntry,
  parseFields,
  readString,
  readVarint,
  readVarintBigint,
  readVarintString,
  readMessage,
  findField,
  findFields,
  WireType,
  type ProtobufField,
} from '../crypto/protobuf.js';
import type { SessionData } from '../auth/session.js';

const log = createLogger('im-ops');

/** 全局自增 sequence_id（从 10001 开始，与抓包样本一致） */
let _seq = 10001;
function nextSeq(): number {
  return _seq++;
}

/** 联系人/会话条目（与 im/bridge.ts ContactItem 兼容） */
export interface ContactItem {
  conversationId: string;
  uid: string;
  secUid?: string;
  nickname: string;
  remark?: string;
  lastMessage: string;
  lastMessageTs?: number;
  /**
   * 未读消息数 = conv.10 - conv.51.16。
   * 经 probe-unread-v4 验证：
   *   - conv.10 是当前 badge seq（最新消息的 badge 序号）
   *   - conv.51.16 是已读 badge seq（read_index 在 badge 系统中的对应值）
   *   - 差值 = 真正未读数（与 GET_READ_INDEX + max_seq 计算结果一致）
   *   - TwT: conv.10=1629, conv.51.16=1624, 差值=5 = max_seq(4106) - read_index(4101)
   *   - 已读会话: conv.10 = conv.51.16, 差值=0
   * 注意：conv.51.14 (read_index=4101) 与 conv.51.16 (1624) 是不同的编号系统，
   *       conv.51.14 是 cursor_seq（与 msg.17 同系），conv.51.16 是 badge seq（与 conv.10 同系）。
   */
  unreadCount?: number;
  /** 已读位置 read_index（conv.51.14，cursor_seq 系统），用于单条消息未读判断 */
  readIndex?: number;
  isPinned?: boolean;
  isStranger?: boolean;
  conversationType?: number;
  conversationShortId?: string;
  /** 是否为 AI 小火人会话（field 60 含小火人元数据） */
  isAiBot?: boolean;
  /** 内部字段：会话所有参与者（含 uid 和 sec_uid），用于后处理识别 peer */
  _participants?: Array<{ uid: string; secUid: string }>;
}

/**
 * 消息类别
 *   - text        普通文本消息（aweType=700, msgType=7）
 *   - video_share 视频分享（aweType=800, msgType=8）
 *   - ai_text     AI 小火人回复（aweType=716, a:is_from_robot=1）
 *   - system_tip  系统提示（aweType=276，含 tips 字段）
 *   - image       图片消息
 *   - sticker     表情贴纸（aweType=501, msgType=5，含 url 字段）
 *   - unknown     未知类型
 */
export type MessageCategory =
  | 'text'
  | 'video_share'
  | 'ai_text'
  | 'system_tip'
  | 'image'
  | 'sticker'
  | 'recall'
  | 'unknown';

/** 消息条目（与 im/bridge.ts MessageItem 兼容） */
export interface MessageItem {
  msgId: string;
  serverMsgId?: string;
  conversationId: string;
  senderId: string;
  /** 发送者显示名（"我" / "对方" / "小火人" / "系统"） */
  senderLabel: string;
  isSelf: boolean;
  /** 是否为 AI 小火人消息 */
  isFromRobot: boolean;
  messageType: number;
  /** 消息类别 */
  category: MessageCategory;
  /** aweType（抖音业务消息类型） */
  aweType?: number;
  text: string;
  /** 视频分享：作者；其他：undefined */
  videoAuthor?: string;
  /** 表情贴纸：图片 URL；其他：undefined */
  stickerUrl?: string;
  /** 是否为加密图片（msgType=91，阅后即焚），需要调用 getReadOnceImage 解密 */
  isEncryptedImage?: boolean;
  /** 图片 skey（AES-256-GCM 解密密钥，32 字节 hex）
   *  普通图片：来自 content.resource_url.skey
   *  加密图片：来自 read_once/detail 接口 */
  imageSkey?: string;
  contentJson?: string;
  timestamp?: number;
  status?: string;
}

/** 发送结果 */
export interface SendResultData {
  success: boolean;
  msgId?: string;
  serverMsgId?: string;
  reason?: string;
}

/** 从 SessionData 构造 RequestEnv */
export function envFromSession(session: SessionData): RequestEnv {
  return {
    cookie: session.cookie,
    identitySecurityDeviceId: session.cookies['webid'] || '0',
  };
}

/**
 * 列出所有会话（联系人）
 *
 * 抖音 IM 列出常规会话的端点（来自 IM SDK 源码逆向）：
 *   cmd=2006 (GET_USER_CONVERSATION_LIST)
 *   path=/v1/conversation/list
 *   body_type=2006
 *   body 字段（GetUserConversationListRequestBody，字段号从 SDK 源码逆向）：
 *     field 1 (int32): sort_type (default=1)
 *     field 2 (int64): cursor (default=0)
 *     field 3 (int32): con_type (default=1, 1=私聊, 0=全部但实测返回空)
 *     field 4 (int64): limit (default=0)
 *     field 5 (int32): include_role (default=0)
 *     field 6 (int32): exclude_role (default=0)
 *     field 8 (bool):  with_cold (default=false)
 *     field 10 (int32): push_status (default=0)
 *
 * 响应字段（GetUserConversationListResponseBody）：
 *   field 1 (repeated ConversationInfoV2): list
 *   field 2 (bool): has_more
 *   field 3 (int64): next_cursor
 *
 * 另外也尝试 cmd=1001 (stranger_get_conversation_list) 列出陌生人会话。
 *
 * @returns 联系人列表
 */
export async function listContacts(env: RequestEnv): Promise<ContactItem[]> {
  const items: ContactItem[] = [];

  // 1. 主流程：cmd=2006 列出常规会话（分页拉取）
  log.info(`listContacts: 调用 cmd=2006 (GET_USER_CONVERSATION_LIST)`);
  let cursor = 0;
  const pageSize = 50;
  let pageCount = 0;
  const maxPages = 10; // 安全上限，避免无限循环
  try {
    while (pageCount < maxPages) {
      pageCount++;
      // body 字段号（从 SDK 源码 c58fe...js 的 GetUserConversationListRequestBody.encode 逆向）：
      const subBody = Buffer.concat([
        encodeVarintField(1, 1), // sort_type=1 (default)
        encodeVarintField(2, cursor), // cursor
        encodeVarintField(3, 1), // con_type=1 私聊
        encodeVarintField(4, pageSize), // limit
        encodeVarintField(5, 0), // include_role=0
        encodeVarintField(6, 0), // exclude_role=0
        // field 8 with_cold 跳过 (default false)
        // field 10 push_status 跳过 (default 0)
      ]);
      const body = encodeBytesField(2006, subBody);

      const reqBuf = buildRequest({
        cmd: 2006, // GET_USER_CONVERSATION_LIST
        sequenceId: nextSeq(),
        inboxType: 0,
        body,
        env,
      });

      const resp = await sendImapi({
        path: '/v1/conversation/list',
        body: reqBuf,
        cookie: env.cookie,
      });
      log.info(
        `listContacts: cmd=2006 page=${pageCount} cursor=${cursor} status=${resp.statusCode} desc=${resp.errorDesc} body=${resp.body.length}B`,
      );
      if (resp.statusCode !== 0) break;

      const pageItems = parseUserConvListResponse(resp, 2006);
      items.push(...pageItems);

      // 解析 has_more / next_cursor
      const bodyFields = parseFields(resp.body);
      const subField = findField(bodyFields, 2006);
      if (!subField) break;
      const subFields = readMessage(subField);
      const hasMore = findField(subFields, 2) ? readVarint(findField(subFields, 2)!) : 0;
      const nextCursor = findField(subFields, 3) ? readVarint(findField(subFields, 3)!) : 0;
      log.info(
        `listContacts: page=${pageCount} got=${pageItems.length} hasMore=${hasMore} nextCursor=${nextCursor}`,
      );
      if (!hasMore || nextCursor <= cursor) break;
      cursor = nextCursor;
    }
  } catch (e) {
    log.warn(`listContacts: cmd=2006 失败`, e);
  }

  // 2. 补充：cmd=1001 列出陌生人会话（inbox_type=1）
  log.info(`listContacts: 调用 cmd=1001 (STRANGER_GET_CONVERSATION_LIST)`);
  try {
    // 字段号（从 SDK 源码 GetStrangerConversationListRequestBody 逆向）：
    //   field 1 (int64): cursor
    //   field 2 (int64): count (default=50)
    //   field 3 (bool):  show_total_unread
    const subBody = Buffer.concat([
      encodeVarintField(1, 0), // cursor=0
      encodeVarintField(2, 50), // count=50
    ]);
    const body = encodeBytesField(1000, subBody);

    const reqBuf = buildRequest({
      cmd: IMAPI_CONSTANTS.IMCMD.STRANGER_GET_CONVERSATION_LIST,
      sequenceId: nextSeq(),
      inboxType: 1,
      body,
      env,
    });

    const resp = await sendImapi({
      path: '/v1/stranger/get_conversation_list',
      body: reqBuf,
      cookie: env.cookie,
    });
    log.info(
      `listContacts: cmd=1001 status=${resp.statusCode} desc=${resp.errorDesc} body=${resp.body.length}B`,
    );
    if (resp.statusCode === 0) {
      const strangerItems = parseStrangerListResponse(resp, 1000);
      for (const it of strangerItems) it.isStranger = true;
      items.push(...strangerItems);
    }
  } catch (e) {
    log.warn(`listContacts: cmd=1001 失败`, e);
  }

  log.info(`listContacts: 共 ${items.length} 个会话`);

  // 后处理：根据 myUid 正确识别 peerUid 和 peerSecUid
  // parseUserConvListResponse 中基于 cidUids[1] 的判断不可靠
  // （cid 格式 "0:1:<smaller_uid>:<larger_uid>"，myUid 可能是较小或较大的那个）
  // 正确做法：用 detectMyUid 识别 myUid，然后从 participants 中取 != myUid 的那个
  const myUid = detectMyUid(items);
  if (myUid) {
    for (const c of items) {
      // 优先从 _participants 中查找 != myUid 的参与者
      if (c._participants && c._participants.length > 0) {
        const peer = c._participants.find((p) => p.uid !== myUid);
        if (peer) {
          c.uid = peer.uid;
          c.secUid = peer.secUid || c.secUid;
        }
      }
      // fallback: 从 cid 中提取 peerUid
      if (!c.uid || c.uid === myUid) {
        const parts = c.conversationId.split(':');
        if (parts.length >= 4) {
          const a = parts[2];
          const b = parts[3];
          c.uid = a === myUid ? b : a;
        }
      }
      // 设置占位 nickname（后续由 list 命令调用 getUserInfoBatch 填充真实 nickname）
      if (!c.nickname || c.nickname === '(pending)' || c.nickname.startsWith('(uid:')) {
        if (c.secUid) {
          c.nickname = '(pending)';
        } else {
          c.nickname = `(uid:${c.uid.slice(-6)})`;
        }
      }
    }
    log.info(`listContacts: 识别 myUid=${myUid}，已修正 peerUid/peerSecUid`);
  }

  // 清理内部字段（不需要暴露给外部）
  for (const c of items) delete c._participants;

  return items;
}

/**
 * 解析 cmd=2006 响应 body
 *
 * 响应结构（GetUserConversationListResponseBody）：
 *   field 1 (repeated ConversationInfoV2): list
 *   field 2 (bool): has_more
 *   field 3 (int64): next_cursor
 *
 * ConversationInfoV2 字段（从抓包样本逆向 + probe-conv-specific 验证）：
 *   field 1 (string): conversation_id
 *   field 2 (int64): conversation_short_id
 *   field 3 (int32): conversation_type
 *   field 4 (string): ticket
 *   field 6 (message): participants 容器
 *     field 1 (repeated message): participant entries
 *       field 1 (int64): uid
 *       field 5 (bytes): sec_uid —— 可能是 string，也可能是嵌套 message
 *                       （sec_uid 字符串嵌在 bytes 中，用正则提取最可靠）
 *   field 7 (int32): participants_count
 *   field 8 (bool): is_participant
 *   field 10 (int32): 消息总数（max_seq，不是未读数！大会话值可达 1600+）
 *   field 50 (ConversationCoreInfo): conversation_core_info
 *   field 60 (message): AI 小火人元数据（仅 AI 会话存在）
 *     field 1 (int64): 小火人 uid
 *     field 2 (bytes): 小火人 sec_uid
 *
 * 注意：响应中不含 nickname 字段，nickname 需通过 /aweme/v1/web/im/user/info/ 接口
 *      （仅 Cookie 即可，见 webapi.ts）批量获取
 */
function parseUserConvListResponse(
  resp: ImapiResponse,
  bodyType: number,
): ContactItem[] {
  const items: ContactItem[] = [];
  const bodyFields = parseFields(resp.body);
  const subField = findField(bodyFields, bodyType);
  if (!subField) {
    log.debug(`parseUserConvListResponse: 响应 body 中未找到 sub-field ${bodyType}`);
    return items;
  }
  const subFields = readMessage(subField);
  log.debug(
    `parseUserConvListResponse: sub-fields=${subFields.length} keys=${subFields.map((f) => f.field).join(',')}`,
  );

  // field 1 (repeated): conversation list entries (ConversationInfoV2)
  for (const f of findFields(subFields, 1)) {
    if (f.wire !== 2) continue;
    const eFields = readMessage(f);
    const cid = findField(eFields, 1) ? readString(findField(eFields, 1)!) : '';
    if (!cid) continue;
    // conversation_short_id 是 int64，可能超过 2^53（JS number 精度上限），
    // 必须用 readVarintString 读取完整值，否则会精度丢失
    const shortId = findField(eFields, 2) ? readVarintString(findField(eFields, 2)!) : undefined;
    const type = findField(eFields, 3) ? readVarint(findField(eFields, 3)!) : undefined;
    const ticket = findField(eFields, 4) ? readString(findField(eFields, 4)!) : undefined;
    // field 10 是当前 badge seq（不是未读数！）
    // 真正未读数 = conv.10 - conv.51.16（已读 badge seq）
    // 经 probe-unread-v4 验证：TwT conv.10=1629, conv.51.16=1624, 差值=5 = 真正未读数
    const badgeSeq = findField(eFields, 10) ? readVarint(findField(eFields, 10)!) : undefined;

    // field 51 (会话元数据): 提取 read_index (field 51.14) 和 已读 badge seq (field 51.16)
    // read_index (51.14) 是 cursor_seq 系统（与 msg.17 同系），用于单条消息未读判断
    // 已读 badge seq (51.16) 是 badge 系统（与 conv.10 同系），用于计算未读数
    let readIndex: number | undefined;
    let readBadgeSeq: number | undefined;
    const field51 = findField(eFields, 51);
    if (field51 && field51.wire === 2) {
      const f51Fields = readMessage(field51);
      const riField = findField(f51Fields, 14);
      if (riField) {
        readIndex = readVarint(riField);
      }
      const rbField = findField(f51Fields, 16);
      if (rbField) {
        readBadgeSeq = readVarint(rbField);
      }
    }

    // 计算真正未读数 = badgeSeq - readBadgeSeq
    let unreadCount: number | undefined;
    if (badgeSeq !== undefined && readBadgeSeq !== undefined && badgeSeq >= readBadgeSeq) {
      unreadCount = badgeSeq - readBadgeSeq;
    } else if (badgeSeq !== undefined) {
      // fallback：无 readBadgeSeq 时，仅当 badgeSeq 较小才可能是未读数
      unreadCount = undefined;
    }

    // field 6 (participants): 提取所有参与者的 uid 和 sec_uid
    // 每个参与者是 field 6.1 的嵌套 message，含 field 1 (uid) 和 field 5 (sec_uid)
    const participants: Array<{ uid: string; secUid: string }> = [];
    const field6 = findField(eFields, 6);
    if (field6 && field6.wire === 2) {
      const f6Fields = readMessage(field6);
      // f6Fields 是 repeated field 1，每个是 participant entry
      for (const pField of findFields(f6Fields, 1)) {
        if (pField.wire !== 2) continue;
        const pFields = readMessage(pField);
        const pUid = findField(pFields, 1) ? readVarintString(findField(pFields, 1)!) : '';
        // field 5 可能是 string 或嵌套 message（sec_uid 字符串嵌在 bytes 中）
        // 用正则从原始字节中提取 sec_uid 最可靠
        const pSecUid = extractSecUid(findField(pFields, 5));
        if (pUid) participants.push({ uid: pUid, secUid: pSecUid });
      }
    }

    // field 60 (AI 小火人元数据): field 60.1 = 小火人 uid, field 60.2 = 小火人 sec_uid
    let aiBotUid = '';
    let aiBotSecUid = '';
    let isAiBot = false;
    const field60 = findField(eFields, 60);
    if (field60 && field60.wire === 2) {
      const f60Fields = readMessage(field60);
      aiBotUid = findField(f60Fields, 1) ? readVarintString(findField(f60Fields, 1)!) : '';
      aiBotSecUid = extractSecUid(findField(f60Fields, 2));
      if (aiBotUid || aiBotSecUid) isAiBot = true;
    }

    // 从 cid 格式 "0:1:<uidA>:<uidB>" 提取双方 uid
    const cidParts = cid.split(':');
    const cidUids = cidParts.length >= 4 ? [cidParts[2], cidParts[3]] : [];

    // peerUid 策略：cidUids[1] 是其中一个 participant（可能是我也可能是对方），
    // 对方 uid = participants 中 != cidUids[1] 的那个
    let peerUid = '';
    let peerSecUid: string | undefined;
    if (participants.length >= 2) {
      const peer = participants.find((p) => p.uid !== cidUids[1]);
      if (peer) {
        peerUid = peer.uid;
        peerSecUid = peer.secUid;
      }
    } else if (participants.length === 1) {
      peerUid = participants[0].uid;
      peerSecUid = participants[0].secUid;
    } else {
      // 没有 participants 信息，fallback 到 cidUids[1]
      peerUid = cidUids[1] || '';
    }

    // AI 小火人会话：peer 是小火人，用 field 60 的元数据
    if (isAiBot && aiBotUid && (!peerUid || peerUid === aiBotUid)) {
      peerUid = aiBotUid;
      if (!peerSecUid) peerSecUid = aiBotSecUid;
    }

    items.push({
      conversationId: cid,
      uid: peerUid,
      secUid: peerSecUid,
      // nickname 需通过 /aweme/v1/web/im/user/info/ 接口获取，
      // 暂用占位符，后续由 list 命令调用 getUserInfoBatch 填充
      nickname: peerSecUid ? '(pending)' : `(uid:${peerUid.slice(-6)})`,
      lastMessage: '',
      unreadCount: unreadCount !== undefined ? unreadCount : undefined,
      readIndex,
      conversationType: type,
      conversationShortId: shortId,
      isAiBot,
      // ticket 用于发送消息
      remark: ticket,
      // 保留所有参与者信息，用于后处理中根据 myUid 正确识别 peer
      _participants: participants,
    });
  }
  return items;
}

/**
 * 从 protobuf 字段的原始字节中提取 sec_uid
 *
 * field 5（participants 的 sec_uid 字段）可能是：
 *   1. 纯 string：直接是 sec_uid 字符串
 *   2. 嵌套 message：sec_uid 字符串嵌在 message bytes 的开头部分
 *      （readString 会返回包含 sec_uid + 二进制 tag 的混合字符串）
 *
 * 用正则从 utf-8 字符串中提取最可靠，sec_uid 格式固定以 "MS4wLjAB" 开头。
 */
function extractSecUid(field: ProtobufField | undefined): string {
  if (!field || field.wire !== WireType.LengthDelimited) return '';
  const buf = field.value as Buffer;
  if (buf.length === 0) return '';
  const str = buf.toString('utf-8');
  // sec_uid 格式：MS4wLjABAAAA + base64url 字符（含 - 和 _）
  const match = str.match(/MS4wLjAB[A-Za-z0-9_-]{20,}/);
  return match ? match[0] : '';
}

/**
 * 从会话列表中识别当前账号的 uid
 *
 * 原理：每个会话的 participants 都包含我自己，统计所有 uid 出现频率，
 *      出现在最多会话中的 uid 就是 myUid。
 *
 * @returns 识别到的 myUid，若无法识别返回空字符串
 */
export function detectMyUid(contacts: ContactItem[]): string {
  const uidCount = new Map<string, number>();
  // 通过 cid 反推：cid 格式 "0:1:<uidA>:<uidB>"，myUid 会出现在所有会话的 cid 中
  for (const c of contacts) {
    const parts = c.conversationId.split(':');
    if (parts.length < 4) continue;
    const a = parts[2];
    const b = parts[3];
    uidCount.set(a, (uidCount.get(a) || 0) + 1);
    uidCount.set(b, (uidCount.get(b) || 0) + 1);
  }
  // 出现频率最高的就是 myUid
  let bestUid = '';
  let bestCount = 0;
  for (const [uid, count] of uidCount) {
    if (count > bestCount) {
      bestUid = uid;
      bestCount = count;
    }
  }
  return bestUid;
}

/**
 * 解析 cmd=1001 陌生人会话列表响应
 *
 * 响应结构（GetStrangerConversationListResponseBody）：
 *   field 1 (int64): next_cursor
 *   field 2 (bool): has_more
 *   field 3 (int32): total_unread
 *   field 4 (repeated StrangerConversation): conversation_list
 */
function parseStrangerListResponse(
  resp: ImapiResponse,
  bodyType: number,
): ContactItem[] {
  const items: ContactItem[] = [];
  const bodyFields = parseFields(resp.body);
  const subField = findField(bodyFields, bodyType);
  if (!subField) {
    log.debug(`parseStrangerListResponse: 响应 body 中未找到 sub-field ${bodyType}`);
    return items;
  }
  const subFields = readMessage(subField);
  log.debug(
    `parseStrangerListResponse: sub-fields=${subFields.length} keys=${subFields.map((f) => f.field).join(',')}`,
  );

  // field 4 (repeated): conversation_list (StrangerConversation)
  for (const entry of findFields(subFields, 4)) {
    if (entry.wire !== 2) continue;
    const eFields = readMessage(entry);
    // StrangerConversation 字段（基于 SDK 源码推断）：
    //   field 1 (string): conversation_id
    //   field 2 (int64): conversation_short_id
    //   field 3 (int32): conversation_type
    //   ...（具体字段号待有真实数据时确认）
    const cid = findField(eFields, 1) ? readString(findField(eFields, 1)!) : '';
    if (!cid) continue;
    const shortId = findField(eFields, 2) ? readVarintString(findField(eFields, 2)!) : undefined;
    const type = findField(eFields, 3) ? readVarint(findField(eFields, 3)!) : undefined;
    items.push({
      conversationId: cid,
      uid: extractUidFromCid(cid),
      nickname: '(陌生人)',
      lastMessage: '',
      conversationType: type,
      conversationShortId: shortId,
    });
  }
  return items;
}

/** 从 conversation_id 解析对方 uid（cid 格式: "0:1:A:B"，需配合 myUid 判断） */
export function extractUidFromCid(cid: string, myUid?: string): string {
  const parts = cid.split(':');
  if (parts.length < 4) return '';
  const a = parts[2];
  const b = parts[3];
  if (myUid && a === myUid) return b;
  if (myUid && b === myUid) return a;
  return b; // fallback
}

/** 构造私聊 conversation_id（格式: "0:1:<myUid>:<peerUid>"，较小 uid 在前） */
export function buildPrivateCid(myUid: string, peerUid: string): string {
  const a = BigInt(myUid);
  const b = BigInt(peerUid);
  const [x, y] = a <= b ? [myUid, peerUid] : [peerUid, myUid];
  return `0:1:${x}:${y}`;
}

/**
 * 获取会话历史消息
 *
 * cmd=301 (GET_MESSAGES_BY_CONVERSATION), path=/v1/message/get_by_conversation
 * body_type=301, 内嵌字段（MessagesInConversationRequestBody，从 SDK 源码逆向）：
 *   field 1 (string): conversation_id
 *   field 2 (int32): conversation_type (1=私聊)
 *   field 3 (int64): conversation_short_id
 *   field 4 (int32): direction (MessageDirection 枚举：1=OLDER, 2=NEWER, 3=FROM_LATEST)
 *   field 5 (int64): anchor_index (default=0)
 *   field 6 (int32): limit (default=50)
 *
 * MessageDirection 枚举（从 SDK 源码 c58fe...js 逆向）：
 *   OLDER=1       - 拉取比 anchor_index 更早的消息（向上翻页）
 *   NEWER=2       - 拉取比 anchor_index 更新的消息（向下翻页）
 *   FROM_LATEST=3 - 从最新消息开始拉取（首次拉取必须用此值！）
 *
 * 重要：首次拉取必须用 direction=3 (FROM_LATEST)，否则服务端返回 status=4 "conversation not found"
 *
 * 响应 body 内嵌 sub-field 301（MessagesInConversationResponseBody）：
 *   field 1 (repeated MessageBody): messages
 *   field 2 (int64): next_cursor
 *   field 3 (bool): has_more
 *
 * MessageBody 字段（从 SDK 源码逆向）：
 *   field 1 (string): conversation_id
 *   field 2 (int32): conversation_type
 *   field 3 (int64): server_message_id
 *   field 4 (int64): index_in_conversation
 *   field 5 (int64): conversation_short_id
 *   field 6 (int32): message_type
 *   field 7 (int64): sender
 *   field 8 (string): content (JSON)
 *   field 9 (map<string,string>): ext (repeated entries)
 *   field 10 (int64): create_time
 *   field 12 (int32): status
 *   field 14 (string): sec_sender
 *
 * @param env 请求环境
 * @param conversationId 会话 ID（如 "0:1:517231230585881:1196717705541576"）
 * @param opts.limit 拉取条数（默认 30）
 * @param opts.cursor 起始 anchor_index（默认 0；首次拉取自动使用 FROM_LATEST）
 * @param opts.direction 方向（1=OLDER, 2=NEWER, 3=FROM_LATEST；默认根据 cursor 自动选择）
 * @param opts.conversationShortId 会话短 ID（必填，从 conversation_info 或 last_message 获取）
 * @param opts.myUid 当前登录 uid（用于判断 isSelf）
 */
export async function getHistory(
  env: RequestEnv,
  conversationId: string,
  opts: {
    limit?: number;
    cursor?: number;
    direction?: number;
    conversationShortId: number | string | bigint;
    myUid?: string;
  },
): Promise<MessageItem[]> {
  const limit = opts.limit ?? 30;
  const cursor = opts.cursor ?? 0;
  // 首次拉取（cursor=0）使用 FROM_LATEST；后续翻页用 OLDER 拉更早消息
  const direction = opts.direction ?? (cursor === 0 ? 3 : 1);
  // conversation_short_id 是 int64，可能超过 2^53（JS number 精度上限）
  // 必须用 BigInt 编码，否则会精度丢失导致 "conversation not found"
  const shortIdBig =
    typeof opts.conversationShortId === 'bigint'
      ? opts.conversationShortId
      : BigInt(opts.conversationShortId);
  const bodyType = 301;

  const subBody = Buffer.concat([
    encodeStringField(1, conversationId),
    encodeVarintField(2, 1), // conversation_type=1 私聊
    encodeVarintField(3, shortIdBig), // conversation_short_id (int64)
    encodeVarintField(4, direction),
    encodeVarintField(5, cursor), // anchor_index
    encodeVarintField(6, limit),
  ]);
  const body = encodeBytesField(bodyType, subBody);

  const reqBuf = buildRequest({
    cmd: IMAPI_CONSTANTS.IMCMD.GET_MESSAGES_BY_CONVERSATION,
    sequenceId: nextSeq(),
    inboxType: 0,
    body,
    env,
  });

  log.info(
    `getHistory: cid=${conversationId} shortId=${shortIdBig.toString()} cursor=${cursor} direction=${direction} limit=${limit}`,
  );
  const resp = await sendImapi({
    path: '/v1/message/get_by_conversation',
    body: reqBuf,
    cookie: env.cookie,
  });

  if (resp.statusCode !== 0) {
    log.error(
      `getHistory: 失败 status=${resp.statusCode} desc=${resp.errorDesc} logId=${resp.logId}`,
    );
    return [];
  }

  const parsed = parseHistoryResponseEx(resp, bodyType, conversationId, opts.myUid);
  return parsed.messages;
}

/** getHistory 的完整返回（含分页信息） */
export interface HistoryResult {
  messages: MessageItem[];
  /** 下次翻页用的 anchor_index（用最早消息的 index_in_conversation） */
  nextCursor: bigint;
  /** 服务端是否还有更多历史消息 */
  hasMore: boolean;
}

/**
 * 获取会话历史消息（带分页元数据）
 *
 * 返回 nextCursor（用于翻页）和 hasMore。
 * 翻页方法：下次调用时传入 cursor=nextCursor, direction=1 (OLDER)。
 */
export async function getHistoryEx(
  env: RequestEnv,
  conversationId: string,
  opts: {
    limit?: number;
    cursor?: number | bigint;
    direction?: number;
    conversationShortId: number | string | bigint;
    myUid?: string;
  },
): Promise<HistoryResult> {
  const limit = opts.limit ?? 30;
  const cursorIn = opts.cursor ?? 0;
  // 首次拉取（cursor=0）使用 FROM_LATEST；后续翻页用 OLDER 拉更早消息
  const direction = opts.direction ?? (cursorIn === 0 ? 3 : 1);
  // conversation_short_id 是 int64，可能超过 2^53（JS number 精度上限）
  // 必须用 BigInt 编码，否则会精度丢失导致 "conversation not found"
  const shortIdBig =
    typeof opts.conversationShortId === 'bigint'
      ? opts.conversationShortId
      : BigInt(opts.conversationShortId);
  const cursorBig =
    typeof cursorIn === 'bigint' ? cursorIn : BigInt(cursorIn);
  const bodyType = 301;

  const subBody = Buffer.concat([
    encodeStringField(1, conversationId),
    encodeVarintField(2, 1), // conversation_type=1 私聊
    encodeVarintField(3, shortIdBig), // conversation_short_id (int64)
    encodeVarintField(4, direction),
    encodeVarintField(5, cursorBig), // anchor_index (int64)
    encodeVarintField(6, limit),
  ]);
  const body = encodeBytesField(bodyType, subBody);

  const reqBuf = buildRequest({
    cmd: IMAPI_CONSTANTS.IMCMD.GET_MESSAGES_BY_CONVERSATION,
    sequenceId: nextSeq(),
    inboxType: 0,
    body,
    env,
  });

  log.info(
    `getHistoryEx: cid=${conversationId} shortId=${shortIdBig.toString()} cursor=${cursorBig.toString()} direction=${direction} limit=${limit}`,
  );

  const resp = await sendImapi({
    path: '/v1/message/get_by_conversation',
    body: reqBuf,
    cookie: env.cookie,
  });

  if (resp.statusCode !== 0) {
    log.error(
      `getHistoryEx: 失败 status=${resp.statusCode} desc=${resp.errorDesc} logId=${resp.logId}`,
    );
    return { messages: [], nextCursor: 0n, hasMore: false };
  }

  return parseHistoryResponseEx(resp, bodyType, conversationId, opts.myUid);
}

/**
 * 获取单个会话的全部历史消息（自动翻页）
 *
 * 从最新消息开始向前翻页，直到 has_more=false 或达到 maxMessages 上限。
 *
 * @param env 请求环境
 * @param conversationId 会话 ID
 * @param opts.conversationShortId 会话短 ID（必填）
 * @param opts.myUid 当前登录 uid（用于判断 isSelf）
 * @param opts.pageSize 每页条数（默认 50，最大 100）
 * @param opts.maxMessages 最大拉取条数（默认 1000，安全上限避免无限循环）
 * @param opts.onProgress 每页拉取后的回调（用于 UI 显示进度）
 * @returns 全部历史消息（按时间升序排列）
 */
export async function getHistoryAll(
  env: RequestEnv,
  conversationId: string,
  opts: {
    conversationShortId: number | string | bigint;
    myUid?: string;
    pageSize?: number;
    maxMessages?: number;
    onProgress?: (loaded: number, hasMore: boolean) => void;
  },
): Promise<MessageItem[]> {
  const pageSize = Math.min(opts.pageSize ?? 50, 100);
  const maxMessages = opts.maxMessages ?? 1000;
  const allMessages: MessageItem[] = [];
  const seenIds = new Set<string>();
  let cursor: bigint = 0n;
  let hasMore = true;
  let pageCount = 0;
  const maxPages = Math.ceil(maxMessages / pageSize) + 1;

  while (hasMore && pageCount < maxPages && allMessages.length < maxMessages) {
    pageCount++;
    const result = await getHistoryEx(env, conversationId, {
      conversationShortId: opts.conversationShortId,
      myUid: opts.myUid,
      limit: pageSize,
      cursor: cursor,
      direction: cursor === 0n ? 3 : 1, // 首次 FROM_LATEST，后续 OLDER
    });

    if (result.messages.length === 0) {
      log.info(`getHistoryAll: page=${pageCount} 返回 0 条消息，停止翻页`);
      break;
    }

    // 去重（按 server_message_id 或 client_message_id）
    let newCount = 0;
    for (const m of result.messages) {
      const key = m.serverMsgId || m.msgId;
      if (key && !seenIds.has(key)) {
        seenIds.add(key);
        allMessages.push(m);
        newCount++;
      }
    }

    log.info(
      `getHistoryAll: page=${pageCount} got=${result.messages.length} new=${newCount} total=${allMessages.length} hasMore=${result.hasMore} nextCursor=${result.nextCursor.toString()}`,
    );

    if (opts.onProgress) {
      opts.onProgress(allMessages.length, result.hasMore);
    }

    // 如果本页没有新消息（全部重复），停止翻页
    if (newCount === 0) {
      log.info(`getHistoryAll: page=${pageCount} 全部重复，停止翻页`);
      break;
    }

    hasMore = result.hasMore;
    cursor = result.nextCursor;
  }

  // 按时间升序排列
  allMessages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  log.info(
    `getHistoryAll: 共拉取 ${pageCount} 页，${allMessages.length} 条消息（去重后）`,
  );
  return allMessages;
}

/** 解析 cmd=301 响应 body 为消息列表（含分页元数据） */
function parseHistoryResponseEx(
  resp: ImapiResponse,
  bodyType: number,
  expectedCid: string,
  myUid?: string,
): HistoryResult {
  const items: MessageItem[] = [];
  const bodyFields = parseFields(resp.body);
  const subField = findField(bodyFields, bodyType);
  if (!subField) {
    log.warn(`parseHistoryResponseEx: 响应 body 中未找到 sub-field ${bodyType}`);
    return { messages: items, nextCursor: 0n, hasMore: false };
  }
  const subFields = readMessage(subField);
  log.debug(
    `parseHistoryResponseEx: sub-fields=${subFields.length} keys=${subFields.map((f) => f.field).join(',')}`,
  );

  // field 1 (repeated MessageBody): messages
  let minIndex = 0n; // 用于翻页的 next_cursor（取本批消息中最小的 index_in_conversation）
  for (const f of findFields(subFields, 1)) {
    if (f.wire !== 2) continue;
    const msg = parseMessageBody(f, expectedCid, myUid);
    if (msg) {
      items.push(msg);
      // 跟踪最小 index（用于翻页）
      const idx = extractIndexInConversation(f);
      if (idx !== null && (minIndex === 0n || idx < minIndex)) {
        minIndex = idx;
      }
    }
  }

  // field 2 (int64): next_cursor（服务端建议的下次翻页 cursor）
  const cursorField = findField(subFields, 2);
  const serverNextCursor =
    cursorField && cursorField.wire === WireType.Varint
      ? (cursorField.value as bigint)
      : 0n;
  // field 3 (bool): has_more
  const hasMore = findField(subFields, 3)
    ? readVarint(findField(subFields, 3)!) !== 0
    : false;

  // nextCursor 优先用服务端建议值，否则用本批最小 index
  const nextCursor = serverNextCursor !== 0n ? serverNextCursor : minIndex;

  // 按时间升序排列
  items.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  log.info(
    `parseHistoryResponseEx: 共解析 ${items.length} 条消息 hasMore=${hasMore} nextCursor=${nextCursor.toString()}`,
  );
  return { messages: items, nextCursor, hasMore };
}

/** 从 MessageBody field 中提取 index_in_conversation（field 4，int64） */
function extractIndexInConversation(msgField: ProtobufField): bigint | null {
  try {
    const mFields = readMessage(msgField);
    const idxField = findField(mFields, 4);
    if (idxField && idxField.wire === WireType.Varint) {
      return idxField.value as bigint;
    }
  } catch {
    // ignore
  }
  return null;
}

/** 解析 cmd=301 响应 body 为消息列表 */
function parseHistoryResponse(
  resp: ImapiResponse,
  bodyType: number,
  expectedCid: string,
  myUid?: string,
): MessageItem[] {
  return parseHistoryResponseEx(resp, bodyType, expectedCid, myUid).messages;
}

/** 解析 MessageBody 为消息条目 */
function parseMessageBody(
  f: ProtobufField,
  expectedCid: string,
  myUid?: string,
): MessageItem | null {
  try {
    const mFields = readMessage(f);
    if (mFields.length === 0) return null;

    // MessageBody 字段（从 SDK 源码 c58fe...js 逆向）：
    const cid = findField(mFields, 1) ? readString(findField(mFields, 1)!) : expectedCid;
    // ★ serverId 是 int64，必须用 readVarintBigint 避免精度丢失
    //   （readVarint 返回 number，超过 2^53 会丢失精度，导致 read_once/detail 接口报错）
    const serverIdBig = findField(mFields, 3) ? readVarintBigint(findField(mFields, 3)!) : 0n;
    const msgType = findField(mFields, 6) ? readVarint(findField(mFields, 6)!) : 0;
    // sender 是 int64 uid，可能超过 2^53，用 readVarintString 读取完整值
    const sender = findField(mFields, 7) ? readVarintString(findField(mFields, 7)!) : '';
    const contentStr = findField(mFields, 8) ? readString(findField(mFields, 8)!) : '';
    const createTime = findField(mFields, 10) ? readVarint(findField(mFields, 10)!) : 0;

    // ext map (field 9, repeated entries)
    const ext: Record<string, string> = {};
    for (const ef of findFields(mFields, 9)) {
      if (ef.wire !== 2) continue;
      const eFields = readMessage(ef);
      const k = findField(eFields, 1) ? readString(findField(eFields, 1)!) : '';
      const v = findField(eFields, 2) ? readString(findField(eFields, 2)!) : '';
      if (k) ext[k] = v;
    }

    // 时间戳：优先 ext 中的 s:server_message_create_time，其次 field 10 create_time
    let ts: number | undefined;
    const sct = ext['s:server_message_create_time'];
    if (sct) {
      const n = Number(sct);
      if (!Number.isNaN(n) && n > 0) ts = n > 1e12 ? n : n * 1000;
    }
    if (ts === undefined && createTime > 0) {
      ts = createTime > 1e12 ? createTime : createTime * 1000;
    }

    // client_message_id 从 ext 获取
    const clientId = ext['s:client_message_id'] || '';

    // 解析 content JSON
    let contentObj: any = null;
    if (contentStr.startsWith('{')) {
      try {
        contentObj = JSON.parse(contentStr);
      } catch {
        // 非 JSON，保持 null
      }
    }

    // 提取 aweType
    const aweType = contentObj && typeof contentObj.aweType === 'number' ? contentObj.aweType : undefined;

    // 识别 AI 小火人回复（aweType=716 或 a:is_from_robot=1）
    // 注意：aweType=276 是系统提示（如"精灵自动回复模式已激活"），不算 robot 回复
    const isFromRobot =
      ext['a:is_from_robot'] === '1' ||
      aweType === 716;

    // 识别消息类别
    let category: MessageCategory = 'unknown';
    let text = '';
    let videoAuthor: string | undefined;
    let stickerUrl: string | undefined;
    let isEncryptedImage = false;
    let imageSkey: string | undefined;

    if (contentObj && typeof contentObj === 'object') {
      // 撤回消息（msgType=40001，content 通常为空 {}）
      if (msgType === 40001) {
        category = 'recall';
        text = '撤回了一条消息';
      }
      // 系统提示（aweType=276，含 tips 字段）
      else if (aweType === 276 || typeof contentObj.tips === 'string') {
        category = 'system_tip';
        text = String(contentObj.tips || '');
      }
      // AI 小火人回复（aweType=716）
      else if (isFromRobot) {
        category = 'ai_text';
        text = String(contentObj.text || '');
      }
      // 视频分享（aweType=800, msgType=8）
      else if (aweType === 800 || msgType === 8) {
        category = 'video_share';
        // content_name 是作者名，aweme_title 是视频标题
        videoAuthor = contentObj.content_name ? String(contentObj.content_name) : undefined;
        text = String(contentObj.aweme_title || contentObj.content_title || '');
        // 如果有描述
        if (!text && contentObj.desc) text = String(contentObj.desc);
      }
      // 表情贴纸（aweType=501 自定义表情 / aweType=508 商店表情，msgType=5，含 url.url_list）
      else if (aweType === 501 || aweType === 508 || msgType === 5) {
        category = 'sticker';
        // 优先用 display_name 作为描述，否则用 emoji_from
        const emojiFrom = contentObj.emoji_from ? String(contentObj.emoji_from) : '';
        const displayName = contentObj.display_name ? String(contentObj.display_name) : '';
        text = displayName || (emojiFrom ? `[表情:${emojiFrom}]` : '[表情]');
        // 提取图片 URL（url.url_list[0]）
        const urlList = contentObj.url?.url_list;
        if (Array.isArray(urlList) && urlList.length > 0) {
          stickerUrl = String(urlList[0]);
        }
      }
      // 普通文本（aweType=700）/ 一次性消息（aweType=10400，阅后即焚）
      else if (aweType === 700 || aweType === 10400 || msgType === 7) {
        category = 'text';
        text = String(contentObj.text || '');
      }
      // 图片消息（aweType=702/2702, msgType=2/27/91）
      else if (aweType === 702 || aweType === 2702 || msgType === 2 || msgType === 27 || msgType === 91) {
        category = 'image';
        // 提取图片 URL：优先 resource_url.large_url_list，其次 resource_url.url_list
        const resUrl = contentObj.resource_url;
        if (resUrl && typeof resUrl === 'object') {
          const largeList = resUrl.large_url_list;
          if (Array.isArray(largeList) && largeList.length > 0) {
            stickerUrl = String(largeList[0]);
            text = '[图片]';
          } else {
            const urlList = resUrl.url_list;
            if (Array.isArray(urlList) && urlList.length > 0) {
              stickerUrl = String(urlList[0]);
              text = '[图片]';
            }
          }
          // 普通图片也有 skey（AES-256-GCM 加密），提取供上层解密
          if (typeof resUrl.skey === 'string') {
            imageSkey = resUrl.skey;
          }
        }
        if (!text) {
          // 无直接 URL 的图片，分两种情况：
          // a) msgType=91 且有 encrypt_info → 阅后即焚加密图片（需调 read_once/detail 拿 skey+URL）
          // b) 有 resource_url.skey → 普通加密图片（自己/对方发送，skey 在消息中，用 batch_build_image 换 URL）
          if (msgType === 91 && imageSkey === undefined) {
            // 阅后即焚：skey 不在消息中，需调 read_once/detail 获取
            isEncryptedImage = true;
            const md5 = typeof contentObj.md5 === 'string' ? contentObj.md5 : '';
            const fileMatch = md5.match(/([A-Za-z0-9_]+\.(?:jpg|jpeg|png|webp|gif|bmp))/i);
            if (fileMatch) {
              text = `[加密图片:${fileMatch[1]}]`;
            } else {
              text = '[加密图片]';
            }
          } else if (imageSkey) {
            // 普通加密图片（自己发送的常见此形态）：有 oid+skey 但无 URL
            text = '[图片]';
          } else {
            // 真正未知：无 URL、无 skey、非 msgType=91
            isEncryptedImage = true;
            text = '[加密图片]';
          }
        }
      }
      else {
        // 其他类型，尝试通用字段
        text = String(contentObj.text || contentObj.content_title || contentObj.aweme_title || contentObj.msgHint || contentObj.desc || '');
        // 仍未识别：输出诊断信息，便于后续支持新消息类型（如撤回）
        if (!text) {
          const aweTypeStr = aweType !== undefined ? ` aweType=${aweType}` : '';
          const contentPreview = contentStr.length > 120 ? contentStr.slice(0, 120) + '...' : contentStr;
          text = `[未识别消息 msgType=${msgType}${aweTypeStr}] content=${contentPreview}`;
        }
      }
    } else {
      // 纯文本内容
      text = contentStr;
      if (msgType === 7) category = 'text';
      // 非 JSON、非文本 msgType：输出诊断信息
      else if (!text) {
        text = `[未识别消息 msgType=${msgType}] content=(empty)`;
      }
    }

    // 撤回的原消息：服务端会将 content 替换为 "Recall Content Hided" 占位文本
    // 此类消息是用户操作产生的（用户发了消息后撤回），发送者保持原用户
    if (text === 'Recall Content Hided') {
      category = 'recall';
      text = '撤回了一条消息';
    }

    // 发送者标签
    let senderLabel: string;
    if (isFromRobot) {
      senderLabel = '小火人';
    } else if (category === 'system_tip') {
      senderLabel = '系统';
    } else if (category === 'recall' && msgType === 40001) {
      // msgType=40001 是服务器推送的撤回通知，非用户操作
      senderLabel = '服务器';
    } else {
      const isSelfSender = myUid !== '' && sender === myUid;
      senderLabel = isSelfSender ? '我' : '对方';
    }

    const isSelf = myUid !== '' && sender === myUid;

    return {
      msgId: clientId || (serverIdBig !== 0n ? serverIdBig.toString() : ''),
      serverMsgId: serverIdBig !== 0n ? serverIdBig.toString() : undefined,
      conversationId: String(cid),
      senderId: sender,
      senderLabel,
      isSelf,
      isFromRobot,
      messageType: msgType,
      category,
      aweType,
      text,
      videoAuthor,
      stickerUrl,
      isEncryptedImage,
      imageSkey,
      contentJson: contentStr || undefined,
      timestamp: ts,
    };
  } catch {
    return null;
  }
}

/**
 * 获取会话信息（cmd=610, /v2/conversation/get_info_list）
 *
 * 用于查询指定 conversation_id 的 short_id、type 等元数据。
 * 注意：此接口接受 conversation_id 列表，但不会列出所有会话。
 *
 * body_type=610, 内嵌字段：
 *   field 1 (repeated message): conversation 列表
 *     field 1 (string): conversation_id
 *     field 2 (varint): conversation_short_id
 *     field 3 (varint): conversation_type
 */
export async function getConversationInfo(
  env: RequestEnv,
  conversationIds: string[],
): Promise<
  Array<{
    conversationId: string;
    conversationShortId?: string;
    conversationType?: number;
  }>
> {
  const bodyType = 610;
  const entries: Buffer[] = conversationIds.map((cid) => {
    const entry = Buffer.concat([
      encodeStringField(1, cid),
      // short_id 和 type 服务端会返回，请求时可以只传 cid
    ]);
    return encodeBytesField(1, entry);
  });
  const body = Buffer.concat(entries.length > 0 ? entries : [encodeBytesField(1, Buffer.alloc(0))]);
  const wrappedBody = encodeBytesField(bodyType, body);

  const reqBuf = buildRequest({
    cmd: IMAPI_CONSTANTS.IMCMD.GET_INFO_LIST,
    sequenceId: nextSeq(),
    inboxType: 0,
    body: wrappedBody,
    env,
  });

  log.info(`getConversationInfo: 查询 ${conversationIds.length} 个会话`);
  const resp = await sendImapi({
    path: '/v2/conversation/get_info_list',
    body: reqBuf,
    cookie: env.cookie,
  });

  if (resp.statusCode !== 0) {
    log.error(
      `getConversationInfo: 失败 status=${resp.statusCode} desc=${resp.errorDesc} logId=${resp.logId}`,
    );
    return [];
  }

  return parseInfoResponse(resp, bodyType);
}

/** 解析 cmd=610 响应 */
function parseInfoResponse(
  resp: ImapiResponse,
  bodyType: number,
): Array<{
  conversationId: string;
  conversationShortId?: string;
  conversationType?: number;
}> {
  const items: Array<{
    conversationId: string;
    conversationShortId?: string;
    conversationType?: number;
  }> = [];
  const bodyFields = parseFields(resp.body);
  const subField = findField(bodyFields, bodyType);
  if (!subField) return items;
  const subFields = readMessage(subField);
  // sub-field 1 (repeated): conversation info entries
  for (const ef of findFields(subFields, 1)) {
    if (ef.wire !== 2) continue;
    const eFields = readMessage(ef);
    const cid = findField(eFields, 1) ? readString(findField(eFields, 1)!) : '';
    if (!cid) continue;
    const shortId = findField(eFields, 2) ? readVarint(findField(eFields, 2)!) : undefined;
    const type = findField(eFields, 3) ? readVarint(findField(eFields, 3)!) : undefined;
    items.push({
      conversationId: cid,
      conversationShortId: shortId !== undefined ? String(shortId) : undefined,
      conversationType: type,
    });
  }
  return items;
}

/** 发送消息所需的可选签名信息（缺失时仅尝试无签名发送） */
export interface SendSignContext {
  /** identity_security_token（必填，否则 send 会失败） */
  identitySecurityToken?: string;
  /** identity_security_device_id（与 token 一并返回） */
  identitySecurityDeviceId?: string;
  /** a_bogus 签名（URL query 参数） */
  aBogus?: string;
  /** msToken（URL query 参数） */
  msToken?: string;
  /** bd-ticket-guard-client-data HTTP 头 */
  bdTicketGuardClientData?: string;
  /** bd-ticket-guard-ree-public-key HTTP 头 */
  bdTicketGuardReePublicKey?: string;
  /** bd-ticket-guard-version HTTP 头（默认 "2"） */
  bdTicketGuardVersion?: string;
  /** bd-ticket-guard-web-sign-type HTTP 头（默认 "1"） */
  bdTicketGuardWebSignType?: string;
  /** bd-ticket-guard-web-version HTTP 头（默认 "2"） */
  bdTicketGuardWebVersion?: string;
  /** conversation_short_id（必填，int64 类型，建议传 string 或 bigint 避免精度丢失） */
  conversationShortId: number | string | bigint;
  /** conversation_type（默认 1=私聊） */
  conversationType?: number;
  /** 会话 ticket（与 identity_security_token 不同，是会话级凭证） */
  ticket?: string;
}

/**
 * 发送文本消息
 *
 * cmd=100 (SEND_MESSAGE), path=/v1/message/send
 * body_type=100, 内嵌字段：
 *   field 1 (string): conversation_id
 *   field 2 (varint): conversation_type (1=私聊)
 *   field 3 (varint): conversation_short_id
 *   field 4 (string): content JSON
 *   field 5 (repeated map): ext 条目
 *   field 6 (varint): message_type (7=文本?)
 *   field 7 (string): ticket
 *   field 8 (string): client_message_id (UUID)
 *
 * @param env 请求环境
 * @param conversationId 会话 ID
 * @param text 文本内容
 * @param sign 签名上下文（含 identity_security_token、bd-ticket-guard-* 等）
 */
export async function sendMessage(
  env: RequestEnv,
  conversationId: string,
  text: string,
  sign: SendSignContext,
): Promise<SendResultData> {
  const clientMessageId = randomUUID();
  const now = Date.now();
  // conversation_short_id 是 int64，可能超过 2^53（JS number 精度上限）
  // 必须用 BigInt 编码，否则会精度丢失导致消息发送失败（status=3）
  const shortIdBig =
    typeof sign.conversationShortId === 'bigint'
      ? sign.conversationShortId
      : BigInt(sign.conversationShortId);
  const conversationType = sign.conversationType ?? 1;
  const messageType = 7; // 文本消息
  const ticket = sign.ticket || '';

  // content JSON
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
    ['a:chat_bubble', JSON.stringify({ bubble_id: '7662684283743536666', bubble_source: '1' })],
    ['s:stime', `${now}.5`],
  ];

  const bodyType = 100;
  const parts: Buffer[] = [
    encodeStringField(1, conversationId),
    encodeVarintField(2, conversationType),
    encodeVarintField(3, shortIdBig),
    encodeStringField(4, content),
    ...extEntries.map(([k, v]) => {
      // ext entry 是嵌套 message: field 1=key, field 2=value
      const entry = Buffer.concat([encodeStringField(1, k), encodeStringField(2, v)]);
      return encodeBytesField(5, entry);
    }),
    encodeVarintField(6, messageType),
    encodeStringField(7, ticket),
    encodeStringField(8, clientMessageId),
  ];
  const subBody = Buffer.concat(parts);
  const body = encodeBytesField(bodyType, subBody);

  // 构造 Request，注入 identity_security_* headers
  const reqEnv: RequestEnv = {
    ...env,
    identitySecurityToken: sign.identitySecurityToken,
    identitySecurityDeviceId: sign.identitySecurityDeviceId,
    identitySecurityAid: '',
  };

  const reqBuf = buildRequest({
    cmd: IMAPI_CONSTANTS.IMCMD.SEND_MESSAGE,
    sequenceId: nextSeq(),
    inboxType: 0,
    body,
    env: reqEnv,
  });

  // URL query（仅 send 需要）
  const query: Record<string, string> = {};
  if (sign.aBogus) query.a_bogus = sign.aBogus;
  if (sign.msToken) query.msToken = sign.msToken;

  // bd-ticket-guard HTTP headers
  const extraHeaders: Record<string, string> = {};
  if (sign.bdTicketGuardClientData) {
    extraHeaders['bd-ticket-guard-client-data'] = sign.bdTicketGuardClientData;
  }
  if (sign.bdTicketGuardReePublicKey) {
    extraHeaders['bd-ticket-guard-ree-public-key'] = sign.bdTicketGuardReePublicKey;
  }
  extraHeaders['bd-ticket-guard-version'] = sign.bdTicketGuardVersion || '2';
  extraHeaders['bd-ticket-guard-web-sign-type'] = sign.bdTicketGuardWebSignType || '1';
  extraHeaders['bd-ticket-guard-web-version'] = sign.bdTicketGuardWebVersion || '2';

  log.info(
    `sendMessage: cid=${conversationId} shortId=${shortIdBig} text=${JSON.stringify(text)} clientMsgId=${clientMessageId} signed=${Boolean(sign.aBogus && sign.msToken && sign.bdTicketGuardClientData)}`,
  );

  try {
    const resp = await sendImapi({
      path: '/v1/message/send',
      body: reqBuf,
      cookie: env.cookie,
      query: Object.keys(query).length > 0 ? query : undefined,
      extraHeaders: Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
    });

    if (resp.statusCode !== 0) {
      return {
        success: false,
        msgId: clientMessageId,
        reason: `status=${resp.statusCode} desc=${resp.errorDesc}`,
      };
    }

    // 解析 send_message 响应 body
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
    // server_message_id 是 int64，必须用 readVarintBigint 避免精度丢失
    // （precision loss 会导致后续 recall/read_once 等接口找不到消息）
    const serverIdBig = findField(subFields, 1) ? readVarintBigint(findField(subFields, 1)!) : 0n;
    const status = findField(subFields, 3) ? readVarint(findField(subFields, 3)!) : -1;
    const respClientId = findField(subFields, 4)
      ? readString(findField(subFields, 4)!)
      : clientMessageId;

    if (status === 0 && serverIdBig > 0n) {
      log.info(`sendMessage: 成功 serverMsgId=${serverIdBig} logId=${resp.logId}`);
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
  } catch (e) {
    return {
      success: false,
      msgId: clientMessageId,
      reason: `network-error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * 撤回消息
 *
 * cmd=702 (RECALL_MESSAGE), path=/v1/message/recall
 * body_type=702, 内嵌字段（来自抓包 0332_POST_1407ba90da92 逆向 + send 日志交叉验证）：
 *   field 1 (string): conversation_id
 *   field 2 (int64):  conversation_short_id（与 send 请求的 shortId 一致）
 *   field 3 (int32):  message_type (1=私聊)
 *   field 4 (int64):  server_message_id（要撤回的消息 ID）
 *
 * 字段映射验证：
 *   - send 日志 shortId=7411135054795014695 == recall field 2，故 field 2 = conversation_short_id
 *   - send 响应 serverMsgId=7665962... 与 recall field 4=7665958... 同格式，故 field 4 = server_message_id
 *
 * 认证：仅需 Cookie，无需 a_bogus / msToken / bd-ticket-guard / identity_security_token
 * （与 list/history 同级，远简单于 send_message）
 *
 * 响应：status_code=0 且 error_desc="OK" 即成功
 *
 * @param env 请求环境
 * @param conversationId 会话 ID
 * @param serverMsgId 服务器消息 ID（来自 sendMessage 返回值）
 * @param conversationShortId 会话短 ID（int64，可能超过 JS number 精度）
 */
export async function recallMessage(
  env: RequestEnv,
  conversationId: string,
  serverMsgId: string,
  conversationShortId: string | bigint,
): Promise<SendResultData> {
  const shortIdBig =
    typeof conversationShortId === 'bigint'
      ? conversationShortId
      : BigInt(conversationShortId);
  const serverMsgIdBig = BigInt(serverMsgId);
  const messageType = 1; // 私聊

  // 构造 recall payload（bodyType=702 内嵌）
  const subBody = Buffer.concat([
    encodeStringField(1, conversationId),
    encodeVarintField(2, shortIdBig),
    encodeVarintField(3, messageType),
    encodeVarintField(4, serverMsgIdBig),
  ]);
  const body = encodeBytesField(702, subBody);

  const reqBuf = buildRequest({
    cmd: IMAPI_CONSTANTS.IMCMD.RECALL_MESSAGE,
    sequenceId: nextSeq(),
    inboxType: 0,
    body,
    env,
  });

  log.info(
    `recallMessage: cid=${conversationId} shortId=${shortIdBig} serverMsgId=${serverMsgIdBig}`,
  );

  try {
    const resp = await sendImapi({
      path: '/v1/message/recall',
      body: reqBuf,
      cookie: env.cookie,
    });

    if (resp.statusCode !== 0) {
      return {
        success: false,
        serverMsgId,
        reason: `status=${resp.statusCode} desc=${resp.errorDesc}`,
      };
    }

    log.info(`recallMessage: 成功 logId=${resp.logId}`);
    return {
      success: true,
      serverMsgId,
    };
  } catch (e) {
    return {
      success: false,
      serverMsgId,
      reason: `network-error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * 图片消息所需的上传产物（来自 tos.ts 的 CommitUploadResult）
 */
export interface ImageSendInfo {
  /** 加密后的 Uri（即 resource_url.oid） */
  oid: string;
  /** AES-256-GCM 密钥（即 resource_url.skey） */
  skey: string;
  /** 原图 MD5（即 resource_url.md5） */
  md5: string;
  /** 图片字节数（即 resource_url.data_size） */
  dataSize: number;
  /** 图片宽度（cover_width） */
  width: number;
  /** 图片高度（cover_height） */
  height: number;
}

/**
 * 发送图片消息
 *
 * 与 sendMessage 结构一致，区别：
 *   - message_type = 27（图片，文本为 7）
 *   - content JSON 使用 resource_url 结构，aweType=2702
 *
 * content 格式（基于抓包 0344_POST_52b7180f6024）：
 *   {
 *     "resource_url": { oid, skey, data_size, md5 },
 *     "cover_height": <h>, "cover_width": <w>,
 *     "check_pics": [], "md5": <md5>,
 *     "from_gallery": 1, "aweType": 2702
 *   }
 *
 * @param env 请求环境
 * @param conversationId 会话 ID
 * @param image 图片上传产物（oid/skey/md5/dataSize/width/height）
 * @param sign 签名上下文（与 sendMessage 一致）
 */
export async function sendImage(
  env: RequestEnv,
  conversationId: string,
  image: ImageSendInfo,
  sign: SendSignContext,
): Promise<SendResultData> {
  const clientMessageId = randomUUID();
  const now = Date.now();
  const shortIdBig =
    typeof sign.conversationShortId === 'bigint'
      ? sign.conversationShortId
      : BigInt(sign.conversationShortId);
  const conversationType = sign.conversationType ?? 1;
  const messageType = 27; // 图片消息
  const ticket = sign.ticket || '';

  // content JSON（图片消息）
  const content = JSON.stringify({
    resource_url: {
      oid: image.oid,
      skey: image.skey,
      data_size: image.dataSize,
      md5: image.md5,
    },
    cover_height: image.height,
    cover_width: image.width,
    check_pics: [],
    md5: image.md5,
    from_gallery: 1,
    aweType: 2702,
  });

  // ext map 条目（与文本消息一致）
  const extEntries: Array<[string, string]> = [
    ['s:mentioned_users', ''],
    ['s:client_message_id', clientMessageId],
    ['a:chat_bubble', JSON.stringify({ bubble_id: '7662684283743536666', bubble_source: '1' })],
    ['s:stime', `${now}.5`],
  ];

  const bodyType = 100;
  const parts: Buffer[] = [
    encodeStringField(1, conversationId),
    encodeVarintField(2, conversationType),
    encodeVarintField(3, shortIdBig),
    encodeStringField(4, content),
    ...extEntries.map(([k, v]) => {
      const entry = Buffer.concat([encodeStringField(1, k), encodeStringField(2, v)]);
      return encodeBytesField(5, entry);
    }),
    encodeVarintField(6, messageType),
    encodeStringField(7, ticket),
    encodeStringField(8, clientMessageId),
  ];
  const subBody = Buffer.concat(parts);
  const body = encodeBytesField(bodyType, subBody);

  const reqEnv: RequestEnv = {
    ...env,
    identitySecurityToken: sign.identitySecurityToken,
    identitySecurityDeviceId: sign.identitySecurityDeviceId,
    identitySecurityAid: '',
  };

  const reqBuf = buildRequest({
    cmd: IMAPI_CONSTANTS.IMCMD.SEND_MESSAGE,
    sequenceId: nextSeq(),
    inboxType: 0,
    body,
    env: reqEnv,
  });

  const query: Record<string, string> = {};
  if (sign.aBogus) query.a_bogus = sign.aBogus;
  if (sign.msToken) query.msToken = sign.msToken;

  const extraHeaders: Record<string, string> = {};
  if (sign.bdTicketGuardClientData) {
    extraHeaders['bd-ticket-guard-client-data'] = sign.bdTicketGuardClientData;
  }
  if (sign.bdTicketGuardReePublicKey) {
    extraHeaders['bd-ticket-guard-ree-public-key'] = sign.bdTicketGuardReePublicKey;
  }
  extraHeaders['bd-ticket-guard-version'] = sign.bdTicketGuardVersion || '2';
  extraHeaders['bd-ticket-guard-web-sign-type'] = sign.bdTicketGuardWebSignType || '1';
  extraHeaders['bd-ticket-guard-web-version'] = sign.bdTicketGuardWebVersion || '2';

  log.info(
    `sendImage: cid=${conversationId} shortId=${shortIdBig} oid=${image.oid} ` +
    `${image.width}x${image.height} ${image.dataSize}B clientMsgId=${clientMessageId}`,
  );

  try {
    const resp = await sendImapi({
      path: '/v1/message/send',
      body: reqBuf,
      cookie: env.cookie,
      query: Object.keys(query).length > 0 ? query : undefined,
      extraHeaders: Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
    });

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
    const serverId = findField(subFields, 1) ? readVarint(findField(subFields, 1)!) : 0;
    const status = findField(subFields, 3) ? readVarint(findField(subFields, 3)!) : -1;
    const respClientId = findField(subFields, 4)
      ? readString(findField(subFields, 4)!)
      : clientMessageId;

    if (status === 0 && serverId > 0) {
      log.info(`sendImage: 成功 serverMsgId=${serverId} logId=${resp.logId}`);
      return {
        success: true,
        msgId: respClientId,
        serverMsgId: String(serverId),
      };
    }
    return {
      success: false,
      msgId: respClientId,
      reason: `business status=${status} serverId=${serverId}`,
    };
  } catch (e) {
    return {
      success: false,
      msgId: clientMessageId,
      reason: `network-error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * 表情贴纸发送所需信息（来自抓包 0301/0340 逆向）
 *
 * 注意：image_id 和 package_id 可能是 number 也可能是 string，
 *      抓包中两种类型都出现过（0301 image_id=208846254 number，
 *      0340 image_id="7596015060166639673" string）。
 *      实现中保持原样传入，不强制转换。
 */
export interface StickerSendInfo {
  /** 表情图片 ID（可能是 number 或 string） */
  imageId: number | string;
  /** 表情包 ID（可能是 number 或 string，0 表示无包） */
  packageId: number | string;
  /** 图片宽度（像素） */
  width: number;
  /** 图片高度（像素） */
  height: number;
  /** 图片类型（如 "webp"） */
  imageType: string;
  /** 图片 URI（如 "ies.fe.effect/xxx" 或 "tos-cn-o-0812/xxx"） */
  uri: string;
  /** 签名 URL 列表（通常 2 个） */
  urlList: string[];
  /** 显示名（通常为空字符串） */
  displayName?: string;
}

/**
 * 发送表情贴纸消息
 *
 * 与 sendMessage 结构一致，区别：
 *   - message_type = 5（贴纸，文本为 7）
 *   - content JSON 使用表情元数据结构，aweType=501
 *
 * content 格式（基于抓包 0301/0340 逆向）：
 *   {
 *     "display_name": "",
 *     "height": <h>, "width": <w>,
 *     "image_id": <id>, "image_type": "webp",
 *     "package_id": <pkg>,
 *     "show_notice": false, "resource_type": 0,
 *     "updateConversationTime": true, "createdAt": 0,
 *     "is_card": false, "msgHint": "",
 *     "aweType": 501,
 *     "url": { height:0, data_size:0, uri, url_list, width:0 }
 *   }
 *
 * @param env 请求环境
 * @param conversationId 会话 ID
 * @param sticker 表情贴纸信息
 * @param sign 签名上下文（与 sendMessage 一致）
 */
export async function sendSticker(
  env: RequestEnv,
  conversationId: string,
  sticker: StickerSendInfo,
  sign: SendSignContext,
): Promise<SendResultData> {
  const clientMessageId = randomUUID();
  const now = Date.now();
  const shortIdBig =
    typeof sign.conversationShortId === 'bigint'
      ? sign.conversationShortId
      : BigInt(sign.conversationShortId);
  const conversationType = sign.conversationType ?? 1;
  const messageType = 5; // 表情贴纸消息
  const ticket = sign.ticket || '';

  // content JSON（表情贴纸消息）
  const content = JSON.stringify({
    display_name: sticker.displayName || '',
    height: sticker.height,
    width: sticker.width,
    image_id: sticker.imageId,
    image_type: sticker.imageType,
    package_id: sticker.packageId,
    show_notice: false,
    resource_type: 0,
    updateConversationTime: true,
    createdAt: 0,
    is_card: false,
    msgHint: '',
    aweType: 501,
    url: {
      height: 0,
      data_size: 0,
      uri: sticker.uri,
      url_list: sticker.urlList,
      width: 0,
    },
  });

  // ext map 条目（与文本消息一致）
  const extEntries: Array<[string, string]> = [
    ['s:mentioned_users', ''],
    ['s:client_message_id', clientMessageId],
    ['a:chat_bubble', JSON.stringify({ bubble_id: '7662684283743536666', bubble_source: '1' })],
    ['s:stime', `${now}.5`],
  ];

  const bodyType = 100;
  const parts: Buffer[] = [
    encodeStringField(1, conversationId),
    encodeVarintField(2, conversationType),
    encodeVarintField(3, shortIdBig),
    encodeStringField(4, content),
    ...extEntries.map(([k, v]) => {
      const entry = Buffer.concat([encodeStringField(1, k), encodeStringField(2, v)]);
      return encodeBytesField(5, entry);
    }),
    encodeVarintField(6, messageType),
    encodeStringField(7, ticket),
    encodeStringField(8, clientMessageId),
  ];
  const subBody = Buffer.concat(parts);
  const body = encodeBytesField(bodyType, subBody);

  const reqEnv: RequestEnv = {
    ...env,
    identitySecurityToken: sign.identitySecurityToken,
    identitySecurityDeviceId: sign.identitySecurityDeviceId,
    identitySecurityAid: '',
  };

  const reqBuf = buildRequest({
    cmd: IMAPI_CONSTANTS.IMCMD.SEND_MESSAGE,
    sequenceId: nextSeq(),
    inboxType: 0,
    body,
    env: reqEnv,
  });

  const query: Record<string, string> = {};
  if (sign.aBogus) query.a_bogus = sign.aBogus;
  if (sign.msToken) query.msToken = sign.msToken;

  const extraHeaders: Record<string, string> = {};
  if (sign.bdTicketGuardClientData) {
    extraHeaders['bd-ticket-guard-client-data'] = sign.bdTicketGuardClientData;
  }
  if (sign.bdTicketGuardReePublicKey) {
    extraHeaders['bd-ticket-guard-ree-public-key'] = sign.bdTicketGuardReePublicKey;
  }
  extraHeaders['bd-ticket-guard-version'] = sign.bdTicketGuardVersion || '2';
  extraHeaders['bd-ticket-guard-web-sign-type'] = sign.bdTicketGuardWebSignType || '1';
  extraHeaders['bd-ticket-guard-web-version'] = sign.bdTicketGuardWebVersion || '2';

  log.info(
    `sendSticker: cid=${conversationId} shortId=${shortIdBig} imageId=${sticker.imageId} ` +
    `${sticker.width}x${sticker.height} clientMsgId=${clientMessageId}`,
  );

  try {
    const resp = await sendImapi({
      path: '/v1/message/send',
      body: reqBuf,
      cookie: env.cookie,
      query: Object.keys(query).length > 0 ? query : undefined,
      extraHeaders: Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
    });

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
    // server_message_id 是 int64，必须用 readVarintBigint 避免精度丢失
    const serverIdBig = findField(subFields, 1) ? readVarintBigint(findField(subFields, 1)!) : 0n;
    const status = findField(subFields, 3) ? readVarint(findField(subFields, 3)!) : -1;
    const respClientId = findField(subFields, 4)
      ? readString(findField(subFields, 4)!)
      : clientMessageId;

    if (status === 0 && serverIdBig > 0n) {
      log.info(`sendSticker: 成功 serverMsgId=${serverIdBig} logId=${resp.logId}`);
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
  } catch (e) {
    return {
      success: false,
      msgId: clientMessageId,
      reason: `network-error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * 引用回复的被引用消息信息（来自抓包 0383/0350/0358 逆向）
 *
 * 用于构造 field 11 (refmsg metadata)。
 * 调用方需从历史消息中提取这些字段。
 */
export interface QuoteReplyRef {
  /** 被引用消息的 server_message_id (int64，string 传参避免精度丢失) */
  serverMsgId: string;
  /** 被引用消息的类型 (5=贴纸, 7=文本, 8=视频分享 等) */
  refmsgType: number;
  /** 被引用消息的发送者 uid */
  refmsgUid: string;
  /** 被引用消息的发送者 sec_uid */
  refmsgSecUid: string;
  /** 被引用消息的发送者昵称 */
  refmsgNickname: string;
  /**
   * 被引用消息的短文本表示
   *  - 贴纸: "[表情]"
   *  - 文本: 原文（如 "难道你也觉得我没用吗"）
   *  - 视频分享: "[视频分享]" 或标题
   */
  refmsgShortText: string;
  /**
   * 被引用消息的完整 content JSON（已 stringified）
   * 例如 sticker 消息的 content: '{"aweType":501,"image_id":...}'
   * 注意：传入时必须是字符串（JSON.stringify 后的结果）
   */
  refmsgContent: string;
}

/**
 * 发送引用回复消息（引用某条历史消息进行回复）
 *
 * cmd=100 (SEND_MESSAGE), path=/v1/message/send
 * 与 sendMessage 结构基本一致，区别：
 *   - content JSON 使用 aweType=703（引用回复）
 *   - body 中额外添加 field 11（refmsg 引用元数据，嵌套 message）
 *   - ext 中额外添加 s:ref_content 和 s:ref_is_edited
 *
 * body 字段（基于抓包 0383/0350/0358 逆向）：
 *   field 1-8: 与 sendMessage 一致
 *   field 11 (message): refmsg 引用元数据
 *     field 1 (int64): 被引用消息的 server_message_id
 *     field 2 (string): refmsg 元数据 JSON（含 refmsg_type/content/uid/sec_uid/nickname/refmsg_content）
 *     field 3 (int64): 同 field 1（被引用消息的 server_message_id）
 *     field 4 (int64): 被引用消息的时间戳（格式未完全确定，抓包中为 1672502444400000 形式）
 *     field 5 (repeated ext): 额外 ext 条目
 *       - s:ref_content: 被引用消息的 content JSON（字符串化）
 *       - s:ref_is_edited: "false"
 *
 * @param env 请求环境
 * @param conversationId 会话 ID
 * @param text 回复文本（可以是文本或表情文本如 "[抠鼻]"）
 * @param ref 被引用消息信息
 * @param sign 签名上下文（与 sendMessage 一致）
 */
export async function sendQuoteReply(
  env: RequestEnv,
  conversationId: string,
  text: string,
  ref: QuoteReplyRef,
  sign: SendSignContext,
): Promise<SendResultData> {
  const clientMessageId = randomUUID();
  const now = Date.now();
  const shortIdBig =
    typeof sign.conversationShortId === 'bigint'
      ? sign.conversationShortId
      : BigInt(sign.conversationShortId);
  const conversationType = sign.conversationType ?? 1;
  const messageType = 7; // 引用回复的 message_type 仍然是 7（与文本一致）
  const ticket = sign.ticket || '';

  // content JSON（引用回复，aweType=703）
  const content = JSON.stringify({
    aweType: 703,
    type: 0,
    richTextInfos: [],
    text,
  });

  // ext map 条目（前 4 个与文本消息一致）
  const extEntries: Array<[string, string]> = [
    ['s:mentioned_users', ''],
    ['s:client_message_id', clientMessageId],
    ['a:chat_bubble', JSON.stringify({ bubble_id: '7662684283743536666', bubble_source: '1' })],
    ['s:stime', `${now}.5`],
  ];

  // field 11 内嵌的 ext 条目（s:ref_content 和 s:ref_is_edited）
  // refmsgContent 已经是 stringified JSON，直接用作 s:ref_content 的值
  const refExtEntries: Array<[string, string]> = [
    ['s:ref_content', ref.refmsgContent],
    ['s:ref_is_edited', 'false'],
  ];

  // 构造 refmsg 元数据 JSON（field 2 of field 11）
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

  // 构造 field 11（refmsg 引用元数据，嵌套 message）
  const refServerIdBig = BigInt(ref.serverMsgId);
  const refmsgField11 = Buffer.concat([
    encodeVarintField(1, refServerIdBig), // 被引用消息 server_message_id
    encodeStringField(2, refmsgMeta), // refmsg 元数据 JSON
    encodeVarintField(3, refServerIdBig), // 同 field 1
    // field 4: 时间戳（格式未完全确定，抓包值为 1672502444400000 形式）
    // 暂不设置，服务端未严格校验该字段
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
      const entry = Buffer.concat([encodeStringField(1, k), encodeStringField(2, v)]);
      return encodeBytesField(5, entry);
    }),
    encodeVarintField(6, messageType),
    encodeStringField(7, ticket),
    encodeStringField(8, clientMessageId),
    encodeBytesField(11, refmsgField11), // 引用回复特有的 field 11
  ];
  const subBody = Buffer.concat(parts);
  const body = encodeBytesField(bodyType, subBody);

  const reqEnv: RequestEnv = {
    ...env,
    identitySecurityToken: sign.identitySecurityToken,
    identitySecurityDeviceId: sign.identitySecurityDeviceId,
    identitySecurityAid: '',
  };

  const reqBuf = buildRequest({
    cmd: IMAPI_CONSTANTS.IMCMD.SEND_MESSAGE,
    sequenceId: nextSeq(),
    inboxType: 0,
    body,
    env: reqEnv,
  });

  const query: Record<string, string> = {};
  if (sign.aBogus) query.a_bogus = sign.aBogus;
  if (sign.msToken) query.msToken = sign.msToken;

  const extraHeaders: Record<string, string> = {};
  if (sign.bdTicketGuardClientData) {
    extraHeaders['bd-ticket-guard-client-data'] = sign.bdTicketGuardClientData;
  }
  if (sign.bdTicketGuardReePublicKey) {
    extraHeaders['bd-ticket-guard-ree-public-key'] = sign.bdTicketGuardReePublicKey;
  }
  extraHeaders['bd-ticket-guard-version'] = sign.bdTicketGuardVersion || '2';
  extraHeaders['bd-ticket-guard-web-sign-type'] = sign.bdTicketGuardWebSignType || '1';
  extraHeaders['bd-ticket-guard-web-version'] = sign.bdTicketGuardWebVersion || '2';

  log.info(
    `sendQuoteReply: cid=${conversationId} shortId=${shortIdBig} text=${JSON.stringify(text)} ` +
    `refMsgId=${ref.serverMsgId} refType=${ref.refmsgType} clientMsgId=${clientMessageId}`,
  );

  try {
    const resp = await sendImapi({
      path: '/v1/message/send',
      body: reqBuf,
      cookie: env.cookie,
      query: Object.keys(query).length > 0 ? query : undefined,
      extraHeaders: Object.keys(extraHeaders).length > 0 ? extraHeaders : undefined,
    });

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
    // server_message_id 是 int64，必须用 readVarintBigint 避免精度丢失
    const serverIdBig = findField(subFields, 1) ? readVarintBigint(findField(subFields, 1)!) : 0n;
    const status = findField(subFields, 3) ? readVarint(findField(subFields, 3)!) : -1;
    const respClientId = findField(subFields, 4)
      ? readString(findField(subFields, 4)!)
      : clientMessageId;

    if (status === 0 && serverIdBig > 0n) {
      log.info(`sendQuoteReply: 成功 serverMsgId=${serverIdBig} logId=${resp.logId}`);
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
  } catch (e) {
    return {
      success: false,
      msgId: clientMessageId,
      reason: `network-error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * 获取 identity_security_token（仅 send 需要）
 *
 * 调用 /passport/safe/get_identity_security_token/ 接口。
 * 此接口也需要 a_bogus + msToken 签名（见抓包 categorized/identity_token）。
 *
 * @returns identity_security_token 与 device_id
 */
export async function getIdentitySecurityToken(
  env: RequestEnv,
  sign: { aBogus?: string; msToken?: string },
): Promise<{ token: string; deviceId: string } | null> {
  const url = new URL('https://www.douyin.com/passport/safe/get_identity_security_token/');
  // 基础 query 参数
  url.searchParams.set('scene', 'web_im');
  url.searchParams.set('aid', IMAPI_CONSTANTS.aid);
  url.searchParams.set('fpid', IMAPI_CONSTANTS.fpid);
  if (sign.msToken) url.searchParams.set('msToken', sign.msToken);
  if (sign.aBogus) url.searchParams.set('a_bogus', sign.aBogus);

  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    'user-agent': env.userAgent || IMAPI_CONSTANTS.apiUrl,
    cookie: env.cookie,
    origin: 'https://www.douyin.com',
    referer: 'https://www.douyin.com/',
    'accept-language': 'zh-CN,zh;q=0.9',
  };

  log.info(`getIdentitySecurityToken: GET ${url.pathname}`);
  try {
    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      log.error(`getIdentitySecurityToken: HTTP ${res.status}`);
      return null;
    }
    const j = (await res.json()) as {
      data?: { device_id?: string; identity_security_token?: string };
    };
    if (!j.data?.identity_security_token) {
      log.error(`getIdentitySecurityToken: 响应无 token`);
      return null;
    }
    return {
      token: j.data.identity_security_token,
      deviceId: j.data.device_id || '',
    };
  } catch (e) {
    log.error(`getIdentitySecurityToken 异常`, e);
    return null;
  }
}

/** 重置 sequence_id（仅用于测试） */
export function _resetSeq(): void {
  _seq = 10001;
}
