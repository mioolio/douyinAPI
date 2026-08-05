/**
 * AI 自动回复模块
 *
 * 与 ai-server (d:\Desktop\DYCC\ai-server) 配合使用。
 * 白名单内的用户消息 → 调 ai-server → AI 回复 → 自动发回抖音。
 * 白名单外用户完全不回复，不打扰正常用户。
 *
 * 白名单存储：本地文件 data/ai-whitelist.json（不依赖 ai-server 运行状态）。
 * ai-server 仅负责对话调用（/chat），白名单管理完全在本地完成。
 */

import fs from 'node:fs/promises';
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { sendMessage, sendQuoteReply, extractUidFromCid, getHistory, getHistoryAll, type SendSignContext, type ContactItem, type MessageItem, type QuoteReplyRef } from './api/operations.js';
import type { RequestEnv } from './api/imapi.js';
import { createLogger } from './utils/logger.js';
import { DATA_DIR } from './config/paths.js';
import type { BrowserSender } from './commands/browser-send.js';
import {
  loadReplyLog,
  isReplied,
  shouldReply,
  markReplied,
  getLastRepliedTs,
  getReplyLogStats,
} from './auth/reply-log.js';

const log = createLogger('ai-reply');

/** 浏览器发送器实例（由 watch --ai 命令注入，用于自动签名发送） */
let _browserSender: BrowserSender | null = null;

/**
 * 设置浏览器发送器（watch --ai 启动时调用）
 *
 * 设置后 sendMessageWithRetry 会优先使用浏览器发送（自动签名），
 * 未设置时回退到原生 sendMessage（可能因缺少签名而失败）。
 */
export function setBrowserSender(sender: BrowserSender | null): void {
  _browserSender = sender;
  if (sender) {
    log.info('[AI回复] 浏览器发送器已启用（自动签名模式）');
  } else {
    log.info('[AI回复] 浏览器发送器已关闭，回退到原生发送');
  }
}

/** ai-server 配置（从环境变量读取，缺省指向本地默认） */
const AI_SERVER_BASE = process.env.AI_SERVER_BASE || 'http://127.0.0.1:7861';
/** 是否开启统一存档（所有白名单用户的对话额外汇总到 unified 目录） */
const AI_UNIFIED = process.env.AI_UNIFIED === '1' || process.env.AI_UNIFIED === 'true';

/** 白名单本地存储文件 */
const WHITELIST_FILE = path.join(DATA_DIR, 'ai-whitelist.json');

/** 白名单缓存 */
let whitelistCache: Set<string> | null = null;

/** 白名单文件监听器（热重载） */
let _whitelistWatcher: FSWatcher | null = null;
/** 热重载防抖定时器 */
let _whitelistReloadTimer: ReturnType<typeof setTimeout> | null = null;
/** 标记自己正在写文件，避免写操作触发的 watch 事件打印重载日志 */
let _selfWriting = false;

/** 正在处理中的会话（避免并发重复回复同一条消息） */
const processingCids = new Set<string>();

// 旧的内存去重机制（processedMsgIds / markProcessed / isProcessed）已移除，
// 改用持久化的 reply-log.ts 模块（data/reply-log.json），
// 重启后仍能记住已回复的消息，避免重复回复。

/** 从本地文件加载白名单到缓存 */
async function loadWhitelistFromFile(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(WHITELIST_FILE, 'utf-8');
    const data = JSON.parse(raw) as { whitelist?: string[] };
    whitelistCache = new Set(data.whitelist || []);
  } catch {
    // 文件不存在或解析失败，初始化为空
    whitelistCache = new Set();
  }
  return whitelistCache;
}

/**
 * 启动白名单文件监听（热重载）
 *
 * 监听 data/ai-whitelist.json 变化，文件改动时自动重新加载白名单。
 * 无需关闭 watch --ai，编辑白名单文件后立即生效。
 * 使用防抖（300ms）避免 Windows 上一次写入触发多次事件。
 */
function startWhitelistWatch(): void {
  if (_whitelistWatcher) return;
  try {
    _whitelistWatcher = fsWatch(WHITELIST_FILE, () => {
      // 防抖：300ms 内多次事件只重载一次
      if (_whitelistReloadTimer) clearTimeout(_whitelistReloadTimer);
      _whitelistReloadTimer = setTimeout(() => {
        _whitelistReloadTimer = null;
        // 自己写文件触发的事件，跳过日志（内容一致）
        if (_selfWriting) {
          _selfWriting = false;
          return;
        }
        const oldSet = whitelistCache;
        loadWhitelistFromFile()
          .then((newSet) => {
            const added = Array.from(newSet).filter((u) => !oldSet || !oldSet.has(u));
            const removed = oldSet ? Array.from(oldSet).filter((u) => !newSet.has(u)) : [];
            if (added.length === 0 && removed.length === 0) {
              log.info(`[白名单热重载] 已重新加载: ${newSet.size} 个用户（无变化）`);
            } else {
              log.info(`[白名单热重载] 已重新加载: ${newSet.size} 个用户`);
              if (added.length > 0) log.info(`  新增: ${added.join(', ')}`);
              if (removed.length > 0) log.info(`  移除: ${removed.join(', ')}`);
            }
          })
          .catch((e) => {
            log.warn(`[白名单热重载] 加载失败: ${e}`);
          });
      }, 300);
    });
    _whitelistWatcher.on('error', () => {
      // 监听错误（文件被删除等），关闭监听
      _whitelistWatcher = null;
    });
  } catch {
    // 文件不存在时 fsWatch 会抛错，忽略
  }
}

/** 将白名单缓存写回本地文件 */
async function saveWhitelistToFile(): Promise<void> {
  if (!whitelistCache) return;
  await fs.mkdir(DATA_DIR, { recursive: true });
  const data = { whitelist: Array.from(whitelistCache) };
  // 标记自己正在写文件，避免触发的 watch 事件打印重载日志
  _selfWriting = true;
  await fs.writeFile(WHITELIST_FILE, JSON.stringify(data, null, 2), 'utf-8');
  // 文件可能刚创建（首次 addWhitelist），此时启动监听
  startWhitelistWatch();
}

/** 确保白名单缓存已加载 */
async function ensureCache(): Promise<Set<string>> {
  if (whitelistCache) return whitelistCache;
  const set = await loadWhitelistFromFile();
  startWhitelistWatch();
  return set;
}

/**
 * 重新从本地文件加载白名单（不依赖 ai-server）
 */
export async function refreshWhitelist(): Promise<string[]> {
  const set = await loadWhitelistFromFile();
  startWhitelistWatch();
  log.info(`白名单已加载: ${set.size} 个用户 [${Array.from(set).join(', ')}]`);
  return Array.from(set);
}

/**
 * 判断 uid 是否在白名单内
 * 若白名单未加载则视为不在白名单（保守策略，不打扰）
 */
export function isWhitelisted(uid: string): boolean {
  if (!whitelistCache) return false;
  return whitelistCache.has(uid);
}

/** 获取白名单数组（用于展示，若未加载会触发异步加载但本函数返回当前缓存） */
export function getWhitelist(): string[] {
  return whitelistCache ? Array.from(whitelistCache) : [];
}

/** 添加白名单（本地文件持久化，无需 ai-server） */
export async function addWhitelist(uid: string): Promise<boolean> {
  try {
    const set = await ensureCache();
    if (set.has(uid)) {
      log.info(`uid ${uid} 已在白名单中`);
      return true;
    }
    set.add(uid);
    await saveWhitelistToFile();
    log.info(`已添加白名单: ${uid}`);
    return true;
  } catch (e) {
    log.error(`添加白名单异常: ${e}`);
    return false;
  }
}

/** 移除白名单（本地文件持久化，无需 ai-server） */
export async function removeWhitelist(uid: string): Promise<boolean> {
  try {
    const set = await ensureCache();
    if (!set.has(uid)) {
      log.info(`uid ${uid} 不在白名单中`);
      return true;
    }
    set.delete(uid);
    await saveWhitelistToFile();
    log.info(`已移除白名单: ${uid}`);
    return true;
  } catch (e) {
    log.error(`移除白名单异常: ${e}`);
    return false;
  }
}

/**
 * 调用 ai-server 进行对话
 *
 * @param uid 用户 UID
 * @param message 用户消息文本
 * @param serverMsgId 抖音消息的 serverMsgId（用于 ai-server 按日期存档时记录消息 ID）
 * @returns AI 回复文本，失败返回空字符串
 */
async function askAI(uid: string, message: string, serverMsgId?: string): Promise<string> {
  try {
    const res = await fetch(`${AI_SERVER_BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uid,
        message,
        unified: AI_UNIFIED,
        serverMsgId: serverMsgId || '',
      }),
    });
    if (res.status === 403) {
      // ai-server 不再校验白名单，403 仅为防御性处理
      log.warn(`ai-server 拒绝回复 uid=${uid}（HTTP 403）`);
      return '';
    }
    if (!res.ok) {
      const errText = await res.text();
      log.error(`ai-server 调用失败: HTTP ${res.status} ${errText.slice(0, 200)}`);
      return '';
    }
    const data = await res.json() as { reply?: string; error?: string };
    if (data.error) {
      log.error(`ai-server 返回错误: ${data.error}`);
      return '';
    }
    return data.reply || '';
  } catch (e) {
    log.error(`ai-server 请求异常: ${e}`);
    return '';
  }
}

/** 发送重试间隔（毫秒） */
const SEND_RETRY_DELAY_MS = 1500;
/** 最大重试次数 */
const SEND_MAX_RETRY = 2;

/**
 * 带重试的消息发送
 *
 * 优先使用浏览器发送（自动签名），未设置 BrowserSender 时回退到原生 sendMessage。
 * 抖音服务器偶发返回空响应（body=0B, cmd=0, seq=0），
 * 可能是瞬时风控或服务器抖动。遇到失败时重试，提高送达率。
 *
 * @returns true=发送成功
 */
async function sendMessageWithRetry(
  env: RequestEnv,
  cid: string,
  text: string,
  sign: SendSignContext,
  nickname: string,
): Promise<boolean> {
  for (let attempt = 0; attempt <= SEND_MAX_RETRY; attempt++) {
    let result;
    if (_browserSender) {
      // 浏览器发送（自动签名，secsdk 注入 a_bogus/msToken/bd-ticket-guard 等）
      result = await _browserSender.send(env, cid, text, {
        conversationShortId: sign.conversationShortId,
        conversationType: sign.conversationType,
        ticket: sign.ticket,
      });
    } else {
      // 原生发送（可能因缺少签名而失败）
      result = await sendMessage(env, cid, text, sign);
    }
    if (result.success) {
      log.info(`[AI回复] 已回复 ${nickname}: ${text.slice(0, 50)}`);
      return true;
    }
    if (attempt < SEND_MAX_RETRY) {
      log.warn(`[AI回复] 发送失败(第${attempt + 1}次): ${result.reason || '未知'}，${SEND_RETRY_DELAY_MS}ms后重试...`);
      await new Promise((r) => setTimeout(r, SEND_RETRY_DELAY_MS));
    } else {
      log.error(`[AI回复] 发送失败(已重试${SEND_MAX_RETRY}次): ${result.reason || '未知原因'}`);
    }
  }
  return false;
}

/**
 * 带重试的引用回复发送
 *
 * 优先使用浏览器发送（自动签名），未设置 BrowserSender 时回退到原生 sendQuoteReply。
 */
async function sendQuoteReplyWithRetry(
  env: RequestEnv,
  cid: string,
  text: string,
  ref: QuoteReplyRef,
  sign: SendSignContext,
  nickname: string,
): Promise<boolean> {
  for (let attempt = 0; attempt <= SEND_MAX_RETRY; attempt++) {
    let result;
    if (_browserSender) {
      result = await _browserSender.sendQuoteReply(env, cid, text, ref, {
        conversationShortId: sign.conversationShortId,
        conversationType: sign.conversationType,
        ticket: sign.ticket,
      });
    } else {
      result = await sendQuoteReply(env, cid, text, ref, sign);
    }
    if (result.success) {
      log.info(`[AI回复] 已引用回复 ${nickname}: ${text.slice(0, 50)}`);
      return true;
    }
    if (attempt < SEND_MAX_RETRY) {
      log.warn(`[AI回复] 引用回复失败(第${attempt + 1}次): ${result.reason || '未知'}，${SEND_RETRY_DELAY_MS}ms后重试...`);
      await new Promise((r) => setTimeout(r, SEND_RETRY_DELAY_MS));
    } else {
      log.error(`[AI回复] 引用回复失败(已重试${SEND_MAX_RETRY}次): ${result.reason || '未知原因'}`);
    }
  }
  return false;
}

// ============================ 多消息解析 ============================

/** 解析后的单条消息 */
interface ParsedMessage {
  /** 消息文本（已去除 [system_N] 和 [reply:N] 标记） */
  text: string;
  /** 引用回复序号：1=引用用户最新消息，2=引用上一条... undefined=普通发送 */
  replyN?: number;
}

/**
 * 解析 AI 回复为消息列表
 *
 * 支持的格式：
 *   1. 纯文本（最常见）→ [{ text: "..." }]
 *   2. [reply:1]嗯嗯 → [{ text: "嗯嗯", replyN: 1 }]
 *   3. [system_1]第一条[system_2]第二条 → [{ text: "第一条" }, { text: "第二条" }]
 *   4. [system_1][reply:1]嗯嗯[system_2]晚安 → [{ text: "嗯嗯", replyN: 1 }, { text: "晚安" }]
 */
function parseAiReply(raw: string): ParsedMessage[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  // 不含 [system_ 标记 → 单条消息
  if (!trimmed.includes('[system_')) {
    const m = trimmed.match(/^\[reply:(\d+)\]/);
    if (m) {
      return [{ text: trimmed.slice(m[0].length).trim(), replyN: parseInt(m[1], 10) }];
    }
    return [{ text: trimmed }];
  }

  // 多消息：按 [system_N] 分割
  const messages: ParsedMessage[] = [];
  const parts = trimmed.split(/\[system_\d+\]/);
  // parts[0] 是第一个 [system_N] 之前的内容（通常为空）
  for (let i = 1; i < parts.length; i++) {
    let text = parts[i].trim();
    if (!text) continue;
    const m = text.match(/^\[reply:(\d+)\]/);
    if (m) {
      text = text.slice(m[0].length).trim();
      messages.push({ text, replyN: parseInt(m[1], 10) });
    } else {
      messages.push({ text });
    }
  }

  // 如果没解析出消息（全是空标记），回退到原文
  if (messages.length === 0) return [{ text: trimmed }];
  return messages;
}

/** 多条消息间的延迟范围（毫秒），模拟真人打字间隔 */
const MULTI_MSG_DELAY_MIN = 800;
const MULTI_MSG_DELAY_MAX = 2300;

/**
 * 发送 AI 回复（支持多消息和引用回复）
 *
 * 解析 AI 回复中的 [system_N] 和 [reply:N] 标记，逐条发送。
 * 引用回复（replyN=1）引用用户最新消息。
 * 多条消息间加随机延迟，模拟真人打字节奏。
 *
 * @returns true=至少成功发送一条
 */
async function sendAiReplyWithRetry(
  env: RequestEnv,
  cid: string,
  aiReply: string,
  sign: SendSignContext,
  nickname: string,
  userMessage: MessageItem,
): Promise<boolean> {
  const messages = parseAiReply(aiReply);
  if (messages.length === 0) {
    log.warn('[AI回复] AI 回复解析为空，跳过发送');
    return false;
  }

  // 单条消息：直接发送（不需要延迟）
  if (messages.length === 1) {
    const msg = messages[0];
    if (!msg.text) return false;
    if (msg.replyN === 1 && userMessage.serverMsgId) {
      const ref: QuoteReplyRef = {
        serverMsgId: userMessage.serverMsgId,
        refmsgType: userMessage.messageType,
        refmsgUid: userMessage.senderId,
        refmsgSecUid: '',
        refmsgNickname: nickname,
        refmsgShortText: userMessage.text || '',
        refmsgContent: userMessage.contentJson || '{}',
      };
      return await sendQuoteReplyWithRetry(env, cid, msg.text, ref, sign, nickname);
    }
    return await sendMessageWithRetry(env, cid, msg.text, sign, nickname);
  }

  // 多条消息：逐条发送，带延迟
  log.info(`[AI回复] 多消息发送: ${messages.length} 条`);
  let anySent = false;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg.text) continue;

    let sent: boolean;
    if (msg.replyN === 1 && userMessage.serverMsgId) {
      const ref: QuoteReplyRef = {
        serverMsgId: userMessage.serverMsgId,
        refmsgType: userMessage.messageType,
        refmsgUid: userMessage.senderId,
        refmsgSecUid: '',
        refmsgNickname: nickname,
        refmsgShortText: userMessage.text || '',
        refmsgContent: userMessage.contentJson || '{}',
      };
      sent = await sendQuoteReplyWithRetry(env, cid, msg.text, ref, sign, nickname);
    } else {
      sent = await sendMessageWithRetry(env, cid, msg.text, sign, nickname);
    }

    if (sent) anySent = true;

    // 消息间延迟（最后一条不延迟）
    if (i < messages.length - 1) {
      const delay = MULTI_MSG_DELAY_MIN + Math.random() * (MULTI_MSG_DELAY_MAX - MULTI_MSG_DELAY_MIN);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return anySent;
}

/**
 * 基于 history 拉取的处理函数（推荐使用）
 *
 * 收到 WS 推送后调用此函数。WS 推送只作为通知，不依赖其方向判断，
 * 而是调用 getHistory 拉取权威消息列表，
 * 找到对方发送的、未处理的最新文本消息（category='text'）触发 AI 回复。
 *
 * 节流机制（防风控）：
 *   - 同一 cid 的多次 WS 推送，5 秒内只查询一次 history
 *   - 5 秒内又有推送，标记 pending，5 秒后补查一次
 *   - 避免频繁推送触发抖音风控
 *
 * 去重机制：
 *   - 用 serverMsgId 去重，允许相同文本内容（用户可重复发消息挑衅 AI）
 *
 * @param cid 会话 ID（WS 推送帧里的 conversationId）
 * @param myUid 当前账号 uid
 * @param contacts 联系人列表
 * @param env 请求环境
 */

/** 节流间隔（毫秒）：同一 cid 两次 history 查询的最小间隔 */
const HISTORY_THROTTLE_MS = 5_000;

/** 每个 cid 的节流状态 */
interface ThrottleState {
  /** 上次查询时间戳（毫秒，墙钟） */
  lastQueryTs: number;
  /** 是否有待处理的推送（trailing 调用） */
  pending: boolean;
  /** trailing 定时器 */
  trailingTimer: ReturnType<typeof setTimeout> | null;
  /** 上次已处理的消息的服务端时间戳（毫秒）
   * trailing 查询只处理比此时间更新的消息，避免回复历史消息 */
  lastProcessedMsgTs: number;
}
const throttleState = new Map<string, ThrottleState>();

/**
 * 启动时检查白名单用户的离线消息并回复
 *
 * 不再依赖 unreadCount（不可靠），改为直接拉取最近历史消息，
 * 用持久化的 reply-log.json 判断是否已回复过。
 *
 * 策略：
 *   - 遍历白名单用户，拉取最近 20 条历史消息
 *   - 按时间降序遍历，找最新的、对方发送的、未回复过的文本消息
 *   - 用 reply-log 的 shouldReply(cid, serverMsgId, ts) 判断是否已回复
 *   - 只回复最新的一条（避免刷屏）
 *
 * @param myUid 当前账号 uid
 * @param contacts 联系人列表
 * @param env 请求环境
 * @returns 处理的消息数
 */
export async function processUnreadMessages(
  myUid: string,
  contacts: ContactItem[],
  env: RequestEnv,
): Promise<number> {
  // 确保回复记录已加载
  await loadReplyLog();
  const stats = await getReplyLogStats();
  log.info(`[离线检查] 回复记录: ${stats.totalCids} 个会话, ${stats.totalRecords} 条记录`);

  const whitelist = getWhitelist();
  if (whitelist.length === 0) {
    log.debug('[离线检查] 白名单为空，跳过');
    return 0;
  }

  let totalProcessed = 0;

  for (const uid of whitelist) {
    const contact = contacts.find((c) => c.uid === uid);
    if (!contact) {
      log.debug(`[离线检查] uid=${uid} 不在联系人列表中，跳过`);
      continue;
    }

    const cid = contact.conversationId;
    if (!contact.conversationShortId) {
      log.warn(`[离线检查] ${contact.nickname} 缺少 conversationShortId，跳过`);
      continue;
    }

    // 会话正在处理中，跳过
    if (processingCids.has(cid)) {
      log.debug(`[离线检查] ${contact.nickname} 处理中，跳过`);
      continue;
    }

    processingCids.add(cid);
    try {
      // 拉取最近 20 条历史消息（不依赖 unreadCount）
      const messages = await getHistory(env, cid, {
        limit: 20,
        conversationShortId: contact.conversationShortId,
        myUid,
      });

      if (messages.length === 0) {
        log.debug(`[离线检查] ${contact.nickname} history 返回空`);
        continue;
      }

      // 按时间降序，找最新的对方文本消息且未回复过
      const sorted = [...messages].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      let target: MessageItem | undefined;
      for (const m of sorted) {
        if (m.isSelf) continue;
        if (m.isFromRobot) continue;
        if (m.category !== 'text') continue;
        if (!m.text || !m.text.trim()) continue;
        // 用持久化回复记录判断是否需要回复
        const need = await shouldReply(cid, m.serverMsgId || '', m.timestamp || 0);
        if (!need) {
          log.debug(`[离线检查] ${contact.nickname} 消息 ${m.serverMsgId} 已回复过，跳过`);
          continue;
        }
        target = m;
        break;
      }

      if (!target) {
        log.debug(`[离线检查] ${contact.nickname} 无需回复的新消息`);
        continue;
      }

      // 标记为已回复（在调 AI 之前标记，防止并发重复）
      if (target.serverMsgId) {
        await markReplied(cid, target.serverMsgId, target.timestamp || Date.now());
      }

      // 检测 /context 命令：用户在抖音 APP 中发送的斜杠命令
      if (target.text.trim().startsWith('/context')) {
        log.info(`[离线回复] ${contact.nickname}(${uid}): ${target.text}  [命令]`);
        await handleContextCommand(env, cid, uid, contact, myUid);
        continue;
      }

      log.info(`[离线回复] ${contact.nickname}(${uid}): ${target.text}`);
      const reply = await askAI(uid, target.text, target.serverMsgId);
      if (!reply) {
        log.warn(`[离线回复] AI 未返回内容，跳过发送`);
        continue;
      }

      const sign: SendSignContext = {
        conversationShortId: contact.conversationShortId,
        conversationType: 1,
        ticket: contact.remark || '',
      };
      const sent = await sendAiReplyWithRetry(env, cid, reply, sign, contact.nickname, target);
      if (sent) {
        totalProcessed++;
      }
    } catch (e) {
      log.error(`[离线检查] ${contact.nickname} 处理异常: ${e}`);
    } finally {
      processingCids.delete(cid);
    }
  }

  if (totalProcessed > 0) {
    log.info(`[离线检查] 完成，共回复 ${totalProcessed} 条消息`);
  } else {
    log.debug(`[离线检查] 完成，无需回复的消息`);
  }
  return totalProcessed;
}

export async function handleIncomingMessageViaHistory(
  cid: string,
  myUid: string,
  contacts: ContactItem[],
  env: RequestEnv,
): Promise<void> {
  // 白名单校验：不在白名单完全不打扰（提前过滤，避免无谓查询）
  const peerUid = extractUidFromCid(cid, myUid);
  if (!peerUid) {
    log.warn(`无法从 cid 解析对方 uid: ${cid}`);
    return;
  }
  if (!isWhitelisted(peerUid)) return;

  // 节流：5 秒内同一 cid 只查询一次
  const now = Date.now();
  const st = throttleState.get(cid);
  if (st && now - st.lastQueryTs < HISTORY_THROTTLE_MS) {
    // 在节流窗口内，标记 pending，安排 trailing 查询
    if (!st.pending) {
      st.pending = true;
      const remain = HISTORY_THROTTLE_MS - (now - st.lastQueryTs);
      log.debug(`[AI回复节流] cid=${cid} 节流中，${remain}ms 后补查`);
      if (st.trailingTimer) clearTimeout(st.trailingTimer);
      st.trailingTimer = setTimeout(() => {
        const s = throttleState.get(cid);
        if (s) {
          s.pending = false;
          s.trailingTimer = null;
        }
        // trailing 查询
        doHandleIncomingMessageViaHistory(cid, myUid, contacts, env).catch((e) => {
          log.error(`[AI回复] trailing 查询异常: ${e}`);
        });
      }, remain + 10);
    } else {
      log.debug(`[AI回复节流] cid=${cid} 已有 pending，跳过`);
    }
    return;
  }

  // 不在节流窗口，立即查询
  const existing = throttleState.get(cid);
  throttleState.set(cid, {
    lastQueryTs: now,
    pending: false,
    trailingTimer: null,
    lastProcessedMsgTs: existing?.lastProcessedMsgTs ?? 0,
  });
  await doHandleIncomingMessageViaHistory(cid, myUid, contacts, env);
}

/**
 * 处理 /context 命令
 *
 * 用户在抖音 APP 中发送 /context 命令时触发。
 * 拉取该用户与 AI 的最近聊天记录，作为结构化消息数组发送给 ai-server，
 * ai-server 持久化到用户专用目录（data/users/<uid>/context.json），
 * AI 下次回复时作为对话上下文（而非 system prompt）参考。
 *
 * 设计要点：
 *   - 历史记录作为 user/assistant 消息对注入，不污染 system prompt
 *   - 避免提示词注入攻击（历史内容不进入 system role）
 *   - 持久化到文件，ai-server 重启后仍可加载
 *
 * @returns true=命令已处理（不应再触发 AI 回复）
 */
async function handleContextCommand(
  env: RequestEnv,
  cid: string,
  peerUid: string,
  contact: ContactItem,
  myUid: string,
): Promise<boolean> {
  if (!contact.conversationShortId) {
    log.warn(`[/context] ${contact.nickname} 缺少 conversationShortId，无法拉取历史`);
    return false;
  }

  const sign: SendSignContext = {
    conversationShortId: contact.conversationShortId,
    conversationType: 1,
    ticket: contact.remark || '',
  };
  const nickname = contact.nickname || peerUid;

  log.info(`[/context] 正在拉取 ${nickname} 的历史记录（最多 1000 条，分页每页 50 条）...`);

  try {
    // 用 getHistoryAll 自动分页拉取（单次 limit=1000 会被抖音服务器拒绝 status=500）
    const messages = await getHistoryAll(env, cid, {
      conversationShortId: contact.conversationShortId,
      myUid,
      pageSize: 50,
      maxMessages: 1000,
    });

    if (messages.length === 0) {
      log.warn(`[/context] ${nickname} 无历史记录`);
      await sendMessageWithRetry(env, cid, '暂无历史记录可以加载~', sign, nickname);
      return true;
    }

    // getHistoryAll 已按时间升序返回，直接格式化为结构化消息数组
    const contextMessages: Array<{ role: string; content: string }> = [];
    for (const m of messages) {
      if (m.category !== 'text' || !m.text || !m.text.trim()) continue;
      // 跳过 /context 命令本身，避免命令消息进入上下文
      if (m.text.trim().startsWith('/context')) continue;
      const role = m.isSelf ? 'assistant' : 'user';
      contextMessages.push({ role, content: m.text });
    }

    if (contextMessages.length === 0) {
      log.warn(`[/context] ${nickname} 无文本消息可注入`);
      await sendMessageWithRetry(env, cid, '暂无文本历史记录可以加载~', sign, nickname);
      return true;
    }

    log.info(`[/context] 已格式化 ${contextMessages.length} 条消息，正在注入 AI 上下文...`);

    // 调用 ai-server 的 /inject-context 接口
    const res = await fetch(`${AI_SERVER_BASE}/inject-context`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uid: peerUid,
        messages: contextMessages,
        msgCount: contextMessages.length,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      log.error(`[/context] 注入失败: HTTP ${res.status} ${errText.slice(0, 200)}`);
      await sendMessageWithRetry(env, cid, '历史上下文加载失败，请稍后重试~', sign, nickname);
      return true;
    }

    const result = await res.json() as { ok?: boolean };
    if (result.ok) {
      log.info(`[/context] 已注入 ${contextMessages.length} 条历史上下文 → ${nickname}(${peerUid})`);
      const confirmText = `已为你加载 ${contextMessages.length} 条历史上下文，AI 现在能记住之前的对话啦~`;
      await sendMessageWithRetry(env, cid, confirmText, sign, nickname);
    } else {
      log.error(`[/context] 注入失败: 未知响应`);
      await sendMessageWithRetry(env, cid, '历史上下文加载失败，请稍后重试~', sign, nickname);
    }
  } catch (e) {
    log.error(`[/context] 执行异常: ${e}`);
  }
  return true;
}

/** 实际执行 history 拉取和 AI 回复（不含节流逻辑） */
async function doHandleIncomingMessageViaHistory(
  cid: string,
  myUid: string,
  contacts: ContactItem[],
  env: RequestEnv,
): Promise<void> {
  // 更新节流时间戳
  const st = throttleState.get(cid);
  if (st) st.lastQueryTs = Date.now();

  // 会话正在处理中，跳过避免重复回复
  if (processingCids.has(cid)) {
    log.debug(`[AI回复] cid=${cid} 处理中，跳过`);
    return;
  }

  const peerUid = extractUidFromCid(cid, myUid);
  if (!peerUid) {
    log.warn(`无法从 cid 解析对方 uid: ${cid}`);
    return;
  }

  // 查联系人拿 conversationShortId 和 ticket（发消息和 getHistory 都需要）
  const contact = contacts.find((c) => c.conversationId === cid);
  if (!contact || !contact.conversationShortId) {
    log.warn(`找不到会话信息 cid=${cid}，无法回复`);
    return;
  }

  const nickname = contact.nickname || peerUid;
  processingCids.add(cid);

  try {
    // 拉取最新消息（FROM_LATEST），用 history 的权威方向判断
    const messages = await getHistory(env, cid, {
      limit: 10,
      conversationShortId: contact.conversationShortId,
      myUid,
    });

    if (messages.length === 0) {
      log.warn(`[AI回复] history 返回空: cid=${cid}`);
      return;
    }

    // DEBUG: 打印 history 返回的所有消息，排查 isSelf/category 判断
    log.debug(`[AI回复调试] history 返回 ${messages.length} 条, myUid=${myUid}:`);
    for (const m of messages) {
      const ts = m.timestamp ? new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '?';
      const textPreview = (m.text || '').slice(0, 30).replace(/\n/g, ' ');
      log.debug(
        `[AI回复调试]   id=${m.serverMsgId || '?'} ts=${ts} isSelf=${m.isSelf} isRobot=${m.isFromRobot} cat=${m.category} senderId=${m.senderId} text="${textPreview}"`,
      );
    }

    // 按 timestamp 降序遍历（最新的优先），找最新的、对方发送的、未回复过的文本消息
    let target: MessageItem | undefined;
    const sorted = [...messages].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    for (const m of sorted) {
      // 跳过自己发的
      if (m.isSelf) continue;
      // 跳过 AI 小火人发的
      if (m.isFromRobot) continue;
      // 只处理文本类消息
      if (m.category !== 'text') continue;
      // 跳过空文本
      if (!m.text || !m.text.trim()) continue;
      // 用持久化回复记录判断是否需要回复（替代旧的 isProcessed + lastProcessedTs）
      const need = await shouldReply(cid, m.serverMsgId || '', m.timestamp || 0);
      if (!need) {
        log.debug(`[AI回复调试]   跳过(已回复): id=${m.serverMsgId}`);
        continue;
      }
      target = m;
      break;
    }

    if (!target) {
      // 没有需要处理的对方文本消息（可能是自己发的、撤回、非文本等）
      log.debug(`[AI回复] 无需处理: cid=${cid}（无对方新文本消息）`);
      return;
    }

    // 标记为已回复（在调 AI 之前标记，防止 AI 回复推送回来时重复处理）
    if (target.serverMsgId) {
      await markReplied(cid, target.serverMsgId, target.timestamp || Date.now());
    }
    // 更新内存节流状态（兼容 trailing 查询逻辑）
    if (st && target.timestamp) st.lastProcessedMsgTs = target.timestamp;
    log.debug(`[AI回复调试] 选中 target: id=${target.serverMsgId} ts=${target.timestamp} text="${target.text.slice(0, 50)}"`);

    // 检测 /context 命令：用户在抖音 APP 中发送的斜杠命令
    // 命令不走 AI 回复流程，而是拉取历史记录注入 ai-server 上下文
    const trimmedText = target.text.trim();
    if (trimmedText.startsWith('/context')) {
      log.info(`[AI回复] ${nickname}(${peerUid}): ${target.text}  [命令]`);
      await handleContextCommand(env, cid, peerUid, contact, myUid);
      return;
    }

    log.info(`[AI回复] ${nickname}(${peerUid}): ${target.text}`);
    const reply = await askAI(peerUid, target.text, target.serverMsgId);
    if (!reply) {
      log.warn(`[AI回复] AI 未返回内容，跳过发送`);
      return;
    }

    const sign: SendSignContext = {
      conversationShortId: contact.conversationShortId,
      conversationType: 1,
      ticket: contact.remark || '',
    };
    await sendAiReplyWithRetry(env, cid, reply, sign, nickname, target);
  } catch (e) {
    log.error(`[AI回复] 处理异常: ${e}`);
  } finally {
    processingCids.delete(cid);
  }
}
