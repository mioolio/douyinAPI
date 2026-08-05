/**
 * 回复记录持久化（替代内存 Set 去重）
 *
 * 数据结构：按 cid 分组，记录已回复的 serverMsgId + timestamp
 *
 * 存储格式（JSON 文件）：
 * {
 *   "0:1:xxx:yyy": {
 *     "lastRepliedMsgId": "7445...",
 *     "lastRepliedTs": 1785950000000,
 *     "history": [
 *       { "serverMsgId": "7445...", "ts": 1785950000000, "repliedAt": 1785950010000 }
 *     ]
 *   }
 * }
 *
 * 查询逻辑：
 *   - isReplied(cid, serverMsgId) → 查 history 数组
 *   - shouldReply(cid, msg) → msg.serverMsgId 未在 history 中 且 msg.timestamp > lastRepliedTs
 *
 * 持久化策略：
 *   - 每次写入立即保存（异步防抖 500ms，避免频繁 IO）
 *   - 启动时加载到内存
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';
import { DATA_DIR } from '../config/paths.js';

const log = createLogger('reply-log');

/** 回复记录文件路径 */
const REPLY_LOG_FILE = path.join(DATA_DIR, 'reply-log.json');

/** 单条回复记录 */
interface ReplyRecord {
  /** 对方消息的 serverMsgId */
  serverMsgId: string;
  /** 对方消息的时间戳 */
  ts: number;
  /** AI 回复的时间戳 */
  repliedAt: number;
}

/** 单个 cid 的回复记录 */
interface CidRecord {
  /** 最后回复的消息 serverMsgId */
  lastRepliedMsgId: string;
  /** 最后回复的消息 timestamp */
  lastRepliedTs: number;
  /** 历史回复记录（按时间升序，最多保留 MAX_HISTORY_PER_CID 条） */
  history: ReplyRecord[];
}

/** 整个回复记录数据 */
type ReplyLogData = Record<string, CidRecord>;

/** 每个 cid 最多保留的历史记录数 */
const MAX_HISTORY_PER_CID = 200;

/** 内存缓存 */
let _cache: ReplyLogData | null = null;

/** 防抖保存定时器 */
let _saveTimer: NodeJS.Timeout | null = null;
const SAVE_DEBOUNCE_MS = 500;

/** 加载回复记录到内存 */
export async function loadReplyLog(): Promise<ReplyLogData> {
  try {
    const raw = await fs.readFile(REPLY_LOG_FILE, 'utf-8');
    _cache = JSON.parse(raw) as ReplyLogData;
    log.debug(`已加载回复记录: ${Object.keys(_cache).length} 个会话`);
  } catch {
    _cache = {};
    log.debug('回复记录文件不存在或为空，初始化为空');
  }
  return _cache;
}

/** 确保缓存已加载 */
async function ensureCache(): Promise<ReplyLogData> {
  if (_cache) return _cache;
  return loadReplyLog();
}

/** 防抖保存到文件 */
function scheduleSave(): void {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    _saveTimer = null;
    if (!_cache) return;
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(REPLY_LOG_FILE, JSON.stringify(_cache, null, 2), 'utf-8');
    } catch (e) {
      log.error(`保存回复记录失败: ${e}`);
    }
  }, SAVE_DEBOUNCE_MS);
}

/**
 * 判断消息是否已回复过
 *
 * @param cid 会话 ID
 * @param serverMsgId 消息的 serverMsgId
 * @returns true=已回复过
 */
export async function isReplied(cid: string, serverMsgId: string): Promise<boolean> {
  if (!serverMsgId) return false;
  const data = await ensureCache();
  const record = data[cid];
  if (!record) return false;
  // 快速检查：是否是最后回复的消息
  if (record.lastRepliedMsgId === serverMsgId) return true;
  // 遍历 history 检查
  return record.history.some((r) => r.serverMsgId === serverMsgId);
}

/**
 * 判断消息是否需要回复
 *
 * 综合判断：
 *   1. serverMsgId 未在回复记录中
 *   2. 消息 timestamp 晚于最后回复的 timestamp（兜底，防止 ID 未命中）
 *
 * @param cid 会话 ID
 * @param serverMsgId 消息 serverMsgId
 * @param msgTs 消息 timestamp
 * @returns true=需要回复
 */
export async function shouldReply(
  cid: string,
  serverMsgId: string,
  msgTs: number,
): Promise<boolean> {
  const data = await ensureCache();
  const record = data[cid];
  // 无记录 → 首次对话，需要回复
  if (!record) return true;
  // ID 已在记录中 → 跳过
  if (serverMsgId && await isReplied(cid, serverMsgId)) return false;
  // 时间兜底：消息比最后回复的更早 → 可能是历史消息，跳过
  // （但如果是全新会话 lastRepliedTs=0，不拦截）
  if (record.lastRepliedTs > 0 && msgTs > 0 && msgTs <= record.lastRepliedTs) {
    return false;
  }
  return true;
}

/**
 * 标记消息为已回复
 *
 * @param cid 会话 ID
 * @param serverMsgId 消息 serverMsgId
 * @param msgTs 消息 timestamp
 */
export async function markReplied(
  cid: string,
  serverMsgId: string,
  msgTs: number,
): Promise<void> {
  if (!serverMsgId) return;
  const data = await ensureCache();
  if (!data[cid]) {
    data[cid] = {
      lastRepliedMsgId: serverMsgId,
      lastRepliedTs: msgTs || Date.now(),
      history: [],
    };
  }
  const record = data[cid]!;
  // 避免重复记录
  if (record.history.some((r) => r.serverMsgId === serverMsgId)) {
    return;
  }
  record.history.push({
    serverMsgId,
    ts: msgTs || Date.now(),
    repliedAt: Date.now(),
  });
  // 更新 last 指针
  if (!msgTs || msgTs > record.lastRepliedTs) {
    record.lastRepliedMsgId = serverMsgId;
    record.lastRepliedTs = msgTs || Date.now();
  }
  // 裁剪历史（保留最近 MAX_HISTORY_PER_CID 条）
  if (record.history.length > MAX_HISTORY_PER_CID) {
    record.history = record.history.slice(-MAX_HISTORY_PER_CID);
  }
  scheduleSave();
}

/**
 * 获取 cid 的最后回复时间戳（用于节流判断）
 *
 * @param cid 会话 ID
 * @returns 最后回复的消息 timestamp，无记录返回 0
 */
export async function getLastRepliedTs(cid: string): Promise<number> {
  const data = await ensureCache();
  return data[cid]?.lastRepliedTs ?? 0;
}

/**
 * 获取 cid 的最后回复的 serverMsgId
 *
 * @param cid 会话 ID
 * @returns 最后回复的 serverMsgId，无记录返回空字符串
 */
export async function getLastRepliedMsgId(cid: string): Promise<string> {
  const data = await ensureCache();
  return data[cid]?.lastRepliedMsgId ?? '';
}

/**
 * 清空所有回复记录（调试用）
 */
export async function clearReplyLog(): Promise<void> {
  _cache = {};
  try {
    await fs.writeFile(REPLY_LOG_FILE, '{}', 'utf-8');
    log.info('已清空所有回复记录');
  } catch (e) {
    log.error(`清空回复记录失败: ${e}`);
  }
}

/**
 * 获取回复记录统计信息（调试用）
 */
export async function getReplyLogStats(): Promise<{
  totalCids: number;
  totalRecords: number;
}> {
  const data = await ensureCache();
  let totalRecords = 0;
  for (const record of Object.values(data)) {
    totalRecords += record.history.length;
  }
  return { totalCids: Object.keys(data).length, totalRecords };
}
