/**
 * SPRR 服务封装层
 *
 * 把 SPRR 的逆向 API 包装成网站可调用的服务函数：
 *   - 账号管理（列出/切换/删除/导入 cookie/扫码登录）
 *   - 会话列表
 *   - 消息历史
 *
 * session 缓存策略：按账号名缓存 SessionData，通过文件 mtime 失效。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  envFromSession,
  listContacts,
  getHistory,
  getHistoryEx,
  detectMyUid,
  sendMessage,
  sendImage,
  type ContactItem,
  type MessageItem,
  type SendSignContext,
  type ImageSendInfo,
} from '../sprr/api/operations.js';
import { getUserInfoMap, getReadOnceImage, buildImageUrl, getMyInfo } from '../sprr/api/webapi.js';
import { uploadImage } from '../sprr/api/tos.js';
import { loadFromStorageState, type SessionData } from '../sprr/auth/session.js';
import {
  resolveStorageState,
  listAccounts,
  getCurrentAccount,
  setCurrentAccount,
  deleteAccount,
  saveAccountStorageState,
  accountFile,
  validateAccountName,
} from '../sprr/auth/accounts.js';
import {
  scanBrowserAccounts as doScanBrowser,
  toStorageState,
  type ScannedAccount,
} from './browserScan.js';
import { createLogger } from '../sprr/utils/logger.js';
import {
  upsertConversations,
  upsertMessages,
  upsertContacts,
  getCachedConversations,
  getCachedMessages,
  getMessageById,
  getContactAvatars,
  updateConversationLastMessage,
  getAccountImageDir,
  saveDecryptedImage,
  getDecryptedImage,
  type ConversationRow,
  type MessageRow,
  type ContactRow,
} from './db.js';

const log = createLogger('sprr-service');

/** session 缓存：accountName -> { session, mtimeMs } */
const sessionCache = new Map<string, { session: SessionData; mtimeMs: number }>();

/**
 * 加载指定账号的 session（带缓存）
 *
 * @param accountName 账号名，未指定则用当前账号
 */
async function loadSession(accountName?: string): Promise<SessionData> {
  const { path: statePath, source } = await resolveStorageState(undefined, accountName);
  let stat: { mtimeMs: number };
  try {
    stat = await fs.stat(statePath);
  } catch {
    throw new Error(`storageState 文件不存在: ${statePath}（来源: ${source}）`);
  }

  const cacheKey = accountName || '__current__';
  const cached = sessionCache.get(cacheKey);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.session;
  }

  const session = await loadFromStorageState(statePath);
  // 填充 accountName（用于数据库分库、图片目录隔离）
  // 优先用传入的 accountName，否则读取当前账号；最后兜底用 uid 或 'default'
  if (!session.accountName) {
    session.accountName =
      accountName || (await getCurrentAccount()) || session.uid || 'default';
  }
  sessionCache.set(cacheKey, { session, mtimeMs: stat.mtimeMs });
  return session;
}

/** 失效指定账号的缓存（登录/导入 cookie 后调用） */
export function invalidateSessionCache(accountName?: string): void {
  if (accountName) {
    sessionCache.delete(accountName);
  } else {
    sessionCache.delete('__current__');
  }
}

/** 清空全部缓存 */
export function clearSessionCache(): void {
  sessionCache.clear();
}

/* ----------------------------- 账号管理 ----------------------------- */

export async function listAllAccounts() {
  return listAccounts();
}

export async function getCurrent() {
  return getCurrentAccount();
}

export async function getMyProfile(accountName?: string): Promise<{
  nickname: string;
  avatarUrl: string | null;
  uniqueId?: string;
} | null> {
  const session = await loadSession(accountName);
  if (!session) return null;
  const env = envFromSession(session);
  const info = await getMyInfo(env);
  if (!info) return null;
  return {
    nickname: info.nickname,
    avatarUrl: info.avatarSmall || info.avatarThumb || null,
    uniqueId: info.uniqueId || info.shortId,
  };
}

export async function useAccount(name: string) {
  validateAccountName(name);
  await setCurrentAccount(name);
  invalidateSessionCache('__current__');
}

export async function removeAccount(name: string) {
  validateAccountName(name);
  await deleteAccount(name);
  invalidateSessionCache(name);
}

/**
 * 手动导入 cookie 字符串
 *
 * 用户从浏览器 F12 复制的 cookie 字符串（格式: "k1=v1; k2=v2; ..."）
 * 转换为 Playwright storageState 格式保存为账号文件。
 *
 * name 可选：留空时自动从 cookie 中提取 uid_tt 作为账号名。
 */
export async function importCookie(
  name: string | undefined,
  cookieStr: string,
): Promise<string> {
  const cookiesMap: Record<string, string> = {};
  for (const part of cookieStr.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) cookiesMap[k] = v;
    }
  }
  if (Object.keys(cookiesMap).length === 0) {
    throw new Error('cookie 字符串解析失败，未找到任何键值对');
  }
  if (!cookiesMap['sessionid']) {
    throw new Error('cookie 中缺少 sessionid，可能未登录');
  }

  // 如果未指定 name，从 cookie 中提取 uid_tt
  let accountName = name;
  if (!accountName) {
    const uid = cookiesMap['uid_tt'];
    if (uid && /^\d+$/.test(uid)) {
      accountName = uid;
    } else {
      accountName = `cookie_${Date.now()}`;
    }
  }
  validateAccountName(accountName);

  // 构造 Playwright storageState 格式
  const storageState = {
    cookies: Object.entries(cookiesMap).map(([k, v]) => ({
      name: k,
      value: v,
      domain: '.douyin.com',
      path: '/',
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
    })),
    origins: [],
  };
  await saveAccountStorageState(accountName, storageState);
  invalidateSessionCache(accountName);
  return accountName;
}

/**
 * 启动浏览器扫码登录
 *
 * 不需要预先指定账号名：登录后从 cookie 中提取 uid_tt 作为账号名。
 * 如果 uid_tt 缺失，用时间戳兜底。
 *
 * 注意：此函数会启动 headful Chromium，仅在本地有图形界面的环境可用。
 * 返回登录后的账号名。
 */
export async function loginWithBrowser(
  options: { timeout?: number } = {},
): Promise<string> {
  // 用临时账号名登录，登录后根据 uid_tt 重命名
  const tmpName = `__tmp_${Date.now()}`;
  const { loginAccount } = await import('../sprr/commands/login.js');
  await loginAccount(tmpName, options);

  // 读取临时文件，提取 uid_tt
  const tmpFile = accountFile(tmpName);
  let realName: string;
  try {
    const raw = await fs.readFile(tmpFile, 'utf-8');
    const state = JSON.parse(raw) as { cookies?: Array<{ name: string; value: string }> };
    const uid = state.cookies?.find((c) => c.name === 'uid_tt')?.value;
    if (uid && /^\d+$/.test(uid)) {
      realName = uid;
    } else {
      realName = `tmp_${Date.now()}`;
    }

    // 重新保存为正式账号名
    await saveAccountStorageState(realName, state);
    // 删除临时文件
    if (realName !== tmpName) {
      await fs.unlink(tmpFile).catch(() => {});
    }
    // 设为当前账号
    await setCurrentAccount(realName);
  } catch (e) {
    // 读取失败，保留临时账号名
    realName = tmpName;
    log.warn(`登录后提取 uid_tt 失败，保留临时账号名: ${tmpName}`);
  }

  invalidateSessionCache(realName);
  invalidateSessionCache('__current__');
  return realName;
}

/* ------------------------ 浏览器 Cookie 扫描 ------------------------ */

/**
 * 扫描本机 Chrome/Edge 已登录的抖音账号
 *
 * 返回扫描到的账号列表（前端展示供用户勾选导入）。
 */
export async function scanBrowserAccounts(): Promise<ScannedAccount[]> {
  return doScanBrowser();
}

/**
 * 导入选中的扫描账号
 *
 * 用 uid_tt 作为账号名，如果 uid 缺失则用时间戳兜底。
 * 返回成功导入的账号名列表。
 */
export async function importScannedAccounts(
  selected: ScannedAccount[],
): Promise<string[]> {
  const imported: string[] = [];
  for (const account of selected) {
    let name: string;
    if (account.uid && /^\d+$/.test(account.uid)) {
      name = account.uid;
    } else {
      name = `scan_${Date.now()}`;
    }
    const storageState = toStorageState(account);
    await saveAccountStorageState(name, storageState);
    invalidateSessionCache(name);
    imported.push(name);
    log.info(`已导入扫描账号: ${name}（来源 ${account.browser}/${account.profile}）`);
  }
  // 如果还没有当前账号，自动选第一个
  const current = await getCurrentAccount();
  if (!current && imported.length > 0) {
    await setCurrentAccount(imported[0]);
    invalidateSessionCache('__current__');
  }
  return imported;
}

/* ----------------------------- 业务接口 ----------------------------- */

/** 排序：有 lastMessageTs 按时间倒序，无的按字母排 */
function sortContacts(contacts: ContactItem[]): ContactItem[] {
  return contacts.sort((a, b) => {
    const ta = a.lastMessageTs;
    const tb = b.lastMessageTs;
    // 有时间戳的排前面
    if (ta && !tb) return -1;
    if (!ta && tb) return 1;
    // 都有时间戳：按时间倒序
    if (ta && tb) return tb - ta;
    // 都没有：按 nickname 字母排序
    return (a.nickname || '').localeCompare(b.nickname || '');
  });
}

/** ContactItem 转数据库行 */
function contactToRow(c: ContactItem): ConversationRow {
  return {
    conversation_id: c.conversationId,
    uid: c.uid,
    sec_uid: c.secUid || null,
    nickname: c.nickname,
    remark: c.remark || null,
    last_message: c.lastMessage || '',
    last_message_ts: c.lastMessageTs || null,
    unread_count: c.unreadCount ?? null,
    read_index: c.readIndex ?? null,
    is_pinned: c.isPinned ? 1 : 0,
    is_stranger: c.isStranger ? 1 : 0,
    is_ai_bot: c.isAiBot ? 1 : 0,
    conversation_type: c.conversationType ?? null,
    conversation_short_id: c.conversationShortId || null,
  };
}

/** 数据库行转 ContactItem */
function rowToContact(r: ConversationRow): ContactItem {
  return {
    conversationId: r.conversation_id,
    uid: r.uid,
    secUid: r.sec_uid || undefined,
    nickname: r.nickname,
    remark: r.remark || undefined,
    lastMessage: r.last_message,
    lastMessageTs: r.last_message_ts || undefined,
    unreadCount: r.unread_count ?? undefined,
    readIndex: r.read_index ?? undefined,
    isPinned: Boolean(r.is_pinned),
    isStranger: Boolean(r.is_stranger),
    isAiBot: Boolean(r.is_ai_bot),
    conversationType: r.conversation_type ?? undefined,
    conversationShortId: r.conversation_short_id || undefined,
  };
}

/** MessageItem 转数据库行 */
function messageToRow(account: string, m: MessageItem): MessageRow {
  return {
    msg_id: m.msgId,
    server_msg_id: m.serverMsgId || null,
    conversation_id: m.conversationId,
    sender_id: m.senderId || null,
    sender_label: m.senderLabel || null,
    is_self: m.isSelf ? 1 : 0,
    is_from_robot: m.isFromRobot ? 1 : 0,
    message_type: m.messageType ?? null,
    category: m.category || null,
    awe_type: m.aweType ?? null,
    text: m.text || null,
    video_author: m.videoAuthor || null,
    video_url: (m as MessageItem & { videoUrl?: string }).videoUrl || null,
    sticker_url: m.stickerUrl || null,
    is_encrypted_image: m.isEncryptedImage ? 1 : 0,
    is_permanent: m.isPermanent ? 1 : 0,
    image_skey: m.imageSkey || null,
    image_oid: m.imageOid || null,
    content_json: m.contentJson || null,
    timestamp: m.timestamp ?? null,
    status: m.status || null,
    is_recalled: m.isRecalled ? 1 : 0,
  };
}

/** 数据库行转 MessageItem */
function rowToMessage(r: MessageRow): MessageItem {
  return {
    msgId: r.msg_id,
    serverMsgId: r.server_msg_id || undefined,
    conversationId: r.conversation_id,
    senderId: r.sender_id || '',
    senderLabel: r.sender_label || '',
    isSelf: Boolean(r.is_self),
    isFromRobot: Boolean(r.is_from_robot),
    messageType: r.message_type ?? 0,
    category: (r.category as MessageItem['category']) || 'unknown',
    aweType: r.awe_type ?? undefined,
    text: r.text || '',
    videoAuthor: r.video_author || undefined,
    videoUrl: r.video_url || undefined,
    stickerUrl: r.sticker_url || undefined,
    isEncryptedImage: Boolean(r.is_encrypted_image),
    isPermanent: Boolean(r.is_permanent),
    imageSkey: r.image_skey || undefined,
    imageOid: r.image_oid || undefined,
    contentJson: r.content_json || undefined,
    timestamp: r.timestamp ?? undefined,
    status: r.status || undefined,
    isRecalled: Boolean(r.is_recalled),
  } as MessageItem;
}

/**
 * 获取会话列表（含 nickname 自动解析）
 *
 * 从服务器拉取后写入数据库缓存，再排序返回。
 */
export async function getContactList(accountName?: string): Promise<ContactItem[]> {
  const session = await loadSession(accountName);
  const env = envFromSession(session);
  const account = session.accountName;
  const contacts = await listContacts(env);

  // 批量获取 nickname
  const secUidsToFetch = contacts
    .filter((c) => c.secUid && c.nickname === '(pending)')
    .map((c) => c.secUid!) as string[];
  if (secUidsToFetch.length > 0) {
    const userInfoMap = await getUserInfoMap(env, secUidsToFetch);
    for (const c of contacts) {
      if (!c.secUid) continue;
      const info = userInfoMap.get(c.secUid);
      if (info?.nickname) {
        c.nickname = info.nickname;
      } else if (c.nickname === '(pending)') {
        c.nickname = `(uid:${c.uid.slice(-6)})`;
      }
      // 填充抖音号（优先 unique_id，其次 short_id）
      if (info?.uniqueId) {
        c.douyinId = info.uniqueId;
      } else if (info?.shortId) {
        c.douyinId = info.shortId;
      }
      // 填充头像 URL（优先 avatar_small 168x168，其次 avatar_thumb 100x100）
      if (info?.avatarSmall) {
        c.avatarUrl = info.avatarSmall;
      } else if (info?.avatarThumb) {
        c.avatarUrl = info.avatarThumb;
      }
    }
    // 缓存联系人信息到数据库
    const contactRows: ContactRow[] = [];
    for (const c of contacts) {
      if (c.secUid) {
        contactRows.push({
          uid: c.uid,
          sec_uid: c.secUid,
          nickname: c.nickname,
          remark: c.remark || null,
          avatar_url: c.avatarUrl || null,
        });
      }
    }
    if (contactRows.length > 0) {
      upsertContacts(account, contactRows);
    }
  }

  // 缓存会话列表到数据库
  try {
    upsertConversations(account, contacts.map(contactToRow));
  } catch (e) {
    log.warn(`缓存会话列表失败: ${e}`);
  }

  // 从数据库回填 last_message / last_message_ts（服务器拉取的数据中没有这两个字段，
  // 但数据库中可能已由历史消息加载或发送消息时写入，用于正确排序）
  try {
    const cachedRows = getCachedConversations(account);
    const cacheMap = new Map(cachedRows.map((r) => [r.conversation_id, r]));
    for (const c of contacts) {
      const row = cacheMap.get(c.conversationId);
      if (row) {
        if (row.last_message_ts) c.lastMessageTs = row.last_message_ts;
        if (row.last_message && !c.lastMessage) c.lastMessage = row.last_message;
      }
    }
  } catch (e) {
    log.warn(`回填 last_message_ts 失败: ${e}`);
  }

  return sortContacts(contacts);
}

/** 从本地数据库读取缓存的会话列表（无网络请求） */
export function getCachedContactList(accountName: string): ContactItem[] {
  try {
    const rows = getCachedConversations(accountName);
    const contacts = rows.map(rowToContact);
    // 从 contacts 表回填头像 URL
    if (contacts.length > 0) {
      const uids = contacts.map((c) => c.uid).filter(Boolean);
      const avatarMap = getContactAvatars(accountName, uids);
      for (const c of contacts) {
        const url = avatarMap.get(c.uid);
        if (url) c.avatarUrl = url;
      }
    }
    return sortContacts(contacts);
  } catch {
    return [];
  }
}

/**
 * 获取会话历史消息
 *
 * @param conversationId 会话 ID（0:1:xxx:xxx）
 * @param limit 拉取条数
 * @param accountName 账号名
 * @param cursor 翻页游标（首次不传，加载更多时传上次返回的 nextCursor）
 */
export async function getMessageHistory(
  conversationId: string,
  limit: number = 30,
  accountName?: string,
  cursor?: string,
): Promise<{ messages: MessageItem[]; hasMore: boolean; nextCursor?: string }> {
  const session = await loadSession(accountName);
  const env = envFromSession(session);
  const account = session.accountName;

  // 优先从本地缓存获取联系人（秒级响应，无网络请求）
  // 只有缓存 miss 时才走网络拉取完整联系人列表
  let contacts = getCachedContactList(account);
  if (contacts.length === 0) {
    contacts = await getContactList(accountName);
  }
  const myUid = detectMyUid(contacts);

  const target = contacts.find((c) => c.conversationId === conversationId);
  if (!target) {
    throw new Error(`未找到会话: ${conversationId}`);
  }
  if (!target.conversationShortId) {
    throw new Error(`会话缺少 conversation_short_id: ${conversationId}`);
  }

  // 从服务器拉取消息（带分页元数据）
  const cursorBig = cursor ? BigInt(cursor) : 0;
  const result = await getHistoryEx(env, conversationId, {
    conversationShortId: target.conversationShortId,
    limit,
    myUid,
    cursor: cursorBig,
  });

  // 对撤回消息，先从数据库恢复原始图片信息（必须在缓存之前执行）
  // 因为服务端会清除撤回消息的图片字段，只有数据库中可能保留着原始信息
  for (const m of result.messages) {
    if (m.isRecalled) {
      try {
        const cached = getMessageById(account, m.msgId);
        if (cached) {
          m.category = cached.category === 'image' ? 'image' : m.category;
          m.stickerUrl = cached.sticker_url || m.stickerUrl;
          m.imageSkey = cached.image_skey || m.imageSkey;
          m.imageOid = cached.image_oid || m.imageOid;
          m.isEncryptedImage = cached.is_encrypted_image === 1 ? true : m.isEncryptedImage;
          m.isPermanent = cached.is_permanent === 1 ? true : m.isPermanent;
        }
      } catch (e) {
        log.warn(`恢复撤回消息图片信息失败: ${e}`);
      }
    }
  }

  // 缓存消息到数据库
  try {
    upsertMessages(
      account,
      result.messages.map((m) => messageToRow(account, m)),
    );
  } catch (e) {
    log.warn(`缓存消息失败: ${e}`);
  }

  // 对加密图片消息，查数据库标记是否已解密查看过
  for (const m of result.messages) {
    if (m.isEncryptedImage && m.serverMsgId) {
      try {
        const cached = getDecryptedImage(account, m.serverMsgId);
        m.decrypted = Boolean(cached && cached.local_path);
      } catch {
        m.decrypted = false;
      }
    }
  }

  // 用最新消息的时间戳更新会话排序（首次加载时 cursor 为空才更新，避免翻页时覆盖）
  if (!cursor && result.messages.length > 0) {
    const latestMsg = result.messages.reduce((a, b) =>
      (a.timestamp || 0) > (b.timestamp || 0) ? a : b,
    );
    if (latestMsg.timestamp) {
      const previewText = latestMsg.text || (latestMsg.isEncryptedImage ? '[图片]' : latestMsg.category === 'video_share' ? '[视频]' : latestMsg.category === 'image' || latestMsg.category === 'sticker' ? '[表情]' : '');
      try {
        updateConversationLastMessage(
          account,
          conversationId,
          previewText,
          latestMsg.timestamp,
        );
      } catch (e) {
        log.warn(`更新会话排序时间失败: ${e}`);
      }
    }
  }

  return {
    messages: result.messages,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor.toString(),
  };
}

/** 从本地数据库读取缓存的消息（无网络请求） */
export function getCachedMessageHistory(
  accountName: string,
  conversationId: string,
  limit = 30,
  beforeTs?: number,
): MessageItem[] {
  try {
    const rows = getCachedMessages(accountName, conversationId, limit, beforeTs);
    const msgs = rows.map(rowToMessage);
    // 对加密图片消息标记 decrypted 状态
    for (const m of msgs) {
      if (m.isEncryptedImage && m.serverMsgId) {
        try {
          const cached = getDecryptedImage(accountName, m.serverMsgId);
          m.decrypted = Boolean(cached && cached.local_path);
        } catch {
          m.decrypted = false;
        }
      }
    }
    return msgs;
  } catch {
    return [];
  }
}

/**
 * 发送文本消息
 *
 * 按 SPRR 现状：只填 conversationShortId + ticket + conversationType，
 * 不填 identitySecurityToken/aBogus/msToken 等签名字段（无签名发送）。
 * 能否成功取决于抖音服务器是否强制要求签名。
 *
 * @param conversationId 会话 ID（0:1:xxx:xxx）
 * @param text 文本内容
 * @param accountName 账号名
 */
export async function sendTextMessage(
  conversationId: string,
  text: string,
  accountName?: string,
): Promise<{ success: boolean; msgId?: string; serverMsgId?: string; reason?: string }> {
  const session = await loadSession(accountName);
  const env = envFromSession(session);
  // 优先用缓存获取联系人（发送消息不需要最新联系人列表，有 shortId 即可）
  let contacts = getCachedContactList(session.accountName);
  if (contacts.length === 0) {
    contacts = await getContactList(accountName);
  }

  const target = contacts.find((c) => c.conversationId === conversationId);
  if (!target) {
    throw new Error(`未找到会话: ${conversationId}`);
  }
  if (!target.conversationShortId) {
    throw new Error(`会话缺少 conversation_short_id: ${conversationId}`);
  }

  const sign: SendSignContext = {
    conversationShortId: target.conversationShortId,
    conversationType: target.conversationType ?? 1,
    ticket: target.remark || '',
  };
  log.info(`sendTextMessage: cid=${conversationId} shortId=${target.conversationShortId} text=${JSON.stringify(text)}`);
  const result = await sendMessage(env, conversationId, text, sign);
  log.info(`sendTextMessage: result=${result.success} reason=${result.reason || '-'}`);

  // 发送成功后更新数据库中会话的最后消息和时间戳（动态排序）
  if (result.success) {
    try {
      updateConversationLastMessage(
        session.accountName,
        conversationId,
        text,
        Date.now(),
      );
    } catch (e) {
      log.warn(`更新会话最后消息失败: ${e}`);
    }
  }
  return result;
}

/**
 * 发送图片消息
 *
 * 流程：
 *   1. 上传图片到 TOS（getUploadConfig → applyUploadInner → uploadToTos → commitUploadInner）
 *   2. 用返回的 oid/skey/md5 调用 sendImage 发送图片消息
 *
 * @param conversationId 会话 ID（0:1:xxx:xxx）
 * @param imageBytes 图片字节
 * @param accountName 账号名
 */
export async function sendImageMessage(
  conversationId: string,
  imageBytes: Buffer,
  accountName?: string,
): Promise<{ success: boolean; msgId?: string; serverMsgId?: string; reason?: string }> {
  const session = await loadSession(accountName);
  const env = envFromSession(session);
  // 优先用缓存获取联系人
  let contacts = getCachedContactList(session.accountName);
  if (contacts.length === 0) {
    contacts = await getContactList(accountName);
  }

  const target = contacts.find((c) => c.conversationId === conversationId);
  if (!target) {
    throw new Error(`未找到会话: ${conversationId}`);
  }
  if (!target.conversationShortId) {
    throw new Error(`会话缺少 conversation_short_id: ${conversationId}`);
  }

  // 1. 上传图片到 TOS
  log.info(`sendImageMessage: cid=${conversationId} 上传图片 ${imageBytes.length}B`);
  const commit = await uploadImage(env, imageBytes, session.uid);
  if (!commit) {
    return { success: false, reason: '图片上传失败' };
  }

  // 2. 构造图片发送信息并发送
  const imageInfo: ImageSendInfo = {
    oid: commit.encryptionUri,
    skey: commit.secretKey,
    md5: commit.sourceMd5,
    dataSize: commit.imgSize || imageBytes.length,
    width: commit.imgWidth,
    height: commit.imgHeight,
  };

  const sign: SendSignContext = {
    conversationShortId: target.conversationShortId,
    conversationType: target.conversationType ?? 1,
    ticket: target.remark || '',
  };

  log.info(`sendImageMessage: cid=${conversationId} 发送图片消息 oid=${commit.encryptionUri}`);
  const result = await sendImage(env, conversationId, imageInfo, sign);
  log.info(`sendImageMessage: result=${result.success} reason=${result.reason || '-'}`);

  // 发送成功后更新数据库中会话的最后消息和时间戳
  if (result.success) {
    try {
      updateConversationLastMessage(
        session.accountName,
        conversationId,
        '[图片]',
        Date.now(),
      );
    } catch (e) {
      log.warn(`更新会话最后消息失败: ${e}`);
    }
  }
  return result;
}

/**
 * 解密抖音加密图片（msgType=91，阅后即焚/永久加密）
 *
 * 通过 read_once/detail 接口获取 skey + URL，下载密文后 AES-256-GCM 解密。
 * 永久图片和阅后即焚都走此路径（永久图片也有 once_view_count 限制）。
 *
 * @param msgId 消息 ID（serverMsgId 优先）
 * @param conversationId 会话 ID
 * @param conversationShortId 会话短 ID
 * @param accountName 账号名
 * @returns 本地文件绝对路径，失败返回 null
 */
export async function decryptImage(
  msgId: string,
  conversationId: string,
  conversationShortId: string,
  accountName?: string,
): Promise<string | null> {
  const session = await loadSession(accountName);
  const env = envFromSession(session);
  const account = session.accountName;

  // 1. 先查数据库缓存
  const cached = getDecryptedImage(account, msgId);
  if (cached && cached.local_path) {
    try {
      await fs.access(cached.local_path);
      log.info(`decryptImage: 命中缓存 ${msgId} -> ${cached.local_path}`);
      return cached.local_path;
    } catch {
      log.warn(`decryptImage: 缓存文件不存在，重新下载 ${msgId}`);
    }
  }

  // 2. 调用 read_once/detail 获取下载 URL 和 skey
  log.info(`decryptImage: [加密图片] 调用 getReadOnceImage msgId=${msgId} shortId=${conversationShortId}`);
  const info = await getReadOnceImage(env, msgId, conversationShortId);
  if (!info || !info.largeUrl) {
    log.warn(`decryptImage: [加密图片] getReadOnceImage 返回空（消息可能已被查看过）`);
    return null;
  }

  // 3. 下载密文 + AES-256-GCM 解密
  const plainBuf = await downloadAndDecrypt(info.largeUrl, info.skey, msgId);
  if (!plainBuf) return null;

  // 4. 保存
  const ext = detectImageExt(plainBuf);
  const imgDir = getAccountImageDir(account);
  const filePath = path.join(imgDir, `${msgId}.${ext}`);
  await fs.writeFile(filePath, plainBuf);

  saveDecryptedImage(account, {
    msg_id: msgId,
    conversation_id: conversationId,
    local_path: filePath,
    oid: info.oid || null,
    md5: info.md5 || null,
    data_size: info.dataSize ?? null,
    sender_id: info.senderId || null,
  });

  log.info(`decryptImage: 成功 ${msgId} -> ${filePath} (${plainBuf.length}B, ${ext})`);
  return filePath;
}

/**
 * 解密抖音普通图片（msgType=27，skey 在消息 content.resource_url.skey）
 *
 * 普通图片的 CDN URL 返回的也是 AES-256-GCM 密文，需要用 skey 解密。
 *
 * @param url 图片密文 URL（content.resource_url.large_url_list[0]）
 * @param skey AES-256-GCM 密钥（64 位 hex 字符串）
 * @param msgId 消息 ID（用作缓存键）
 * @param conversationId 会话 ID
 * @param accountName 账号名
 * @returns 本地文件绝对路径，失败返回 null
 */
export async function decryptPlainImage(
  url: string,
  skey: string,
  msgId: string,
  conversationId: string,
  accountName?: string,
): Promise<string | null> {
  const session = await loadSession(accountName);
  const account = session.accountName;

  // 1. 先查数据库缓存
  const cached = getDecryptedImage(account, msgId);
  if (cached && cached.local_path) {
    try {
      await fs.access(cached.local_path);
      log.info(`decryptPlainImage: 命中缓存 ${msgId} -> ${cached.local_path}`);
      return cached.local_path;
    } catch {
      log.warn(`decryptPlainImage: 缓存文件不存在，重新下载 ${msgId}`);
    }
  }

  // 2. 下载密文 + AES-256-GCM 解密
  const plainBuf = await downloadAndDecrypt(url, skey, msgId);
  if (!plainBuf) return null;

  // 3. 保存
  const ext = detectImageExt(plainBuf);
  const imgDir = getAccountImageDir(account);
  const filePath = path.join(imgDir, `${msgId}.${ext}`);
  await fs.writeFile(filePath, plainBuf);

  saveDecryptedImage(account, {
    msg_id: msgId,
    conversation_id: conversationId,
    local_path: filePath,
    oid: null,
    md5: null,
    data_size: null,
    sender_id: null,
  });

  log.info(`decryptPlainImage: 成功 ${msgId} -> ${filePath} (${plainBuf.length}B, ${ext})`);
  return filePath;
}

/**
 * 解密自己发送的图片（消息中只有 oid + skey，无 URL）
 *
 * 流程：
 *   1. 用 oid 调 batch_build_image 接口换签名 URL
 *   2. 下载密文 + AES-256-GCM 解密（与普通图片同一套算法）
 *
 * @param oid 图片明文 URI（content.resource_url.oid）
 * @param skey AES-256-GCM 密钥（64 位 hex 字符串）
 * @param msgId 消息 ID（用作缓存键）
 * @param conversationId 会话 ID
 * @param accountName 账号名
 * @returns 本地文件绝对路径，失败返回 null
 */
export async function decryptImageByOid(
  oid: string,
  skey: string,
  msgId: string,
  conversationId: string,
  accountName?: string,
): Promise<string | null> {
  const session = await loadSession(accountName);
  const account = session.accountName;

  // 1. 先查数据库缓存
  const cached = getDecryptedImage(account, msgId);
  if (cached && cached.local_path) {
    try {
      await fs.access(cached.local_path);
      log.info(`decryptImageByOid: 命中缓存 ${msgId} -> ${cached.local_path}`);
      return cached.local_path;
    } catch {
      log.warn(`decryptImageByOid: 缓存文件不存在，重新下载 ${msgId}`);
    }
  }

  // 2. 用 oid 换签名 URL
  const env = envFromSession(session);
  const urls = await buildImageUrl(env, oid);
  if (urls.length === 0) {
    log.warn(`decryptImageByOid: batch_build_image 失败 oid=${oid} msgId=${msgId}`);
    return null;
  }
  const signedUrl = urls[0];

  // 3. 下载密文 + AES-256-GCM 解密
  const plainBuf = await downloadAndDecrypt(signedUrl, skey, msgId);
  if (!plainBuf) return null;

  // 4. 保存
  const ext = detectImageExt(plainBuf);
  const imgDir = getAccountImageDir(account);
  const filePath = path.join(imgDir, `${msgId}.${ext}`);
  await fs.writeFile(filePath, plainBuf);

  saveDecryptedImage(account, {
    msg_id: msgId,
    conversation_id: conversationId,
    local_path: filePath,
    oid,
    md5: null,
    data_size: null,
    sender_id: null,
  });

  log.info(`decryptImageByOid: 成功 ${msgId} -> ${filePath} (${plainBuf.length}B, ${ext})`);
  return filePath;
}

/**
 * 下载 AES-256-GCM 密文并解密
 *
 * 抖音 IM 所有图片（普通+加密）的 CDN 响应都是密文：
 *   key=skey(32B hex), nonce=密文前12B, tag=密文末16B, 密文=中间
 */
async function downloadAndDecrypt(
  url: string,
  skey: string | undefined,
  msgId: string,
): Promise<Buffer | null> {
  log.info(`downloadAndDecrypt: ${msgId} 下载密文 ${url.slice(0, 80)}...`);
  const resp = await fetch(url, {
    headers: { referer: 'https://www.douyin.com/' },
  });
  if (!resp.ok) {
    log.error(`downloadAndDecrypt: 下载失败 HTTP ${resp.status}`);
    return null;
  }
  const ciphertext = Buffer.from(await resp.arrayBuffer());

  if (!skey || ciphertext.length < 28) {
    log.warn(`downloadAndDecrypt: 无 skey 或密文太短，直接保存密文`);
    return ciphertext;
  }

  try {
    const key = Buffer.from(skey, 'hex');
    if (key.length !== 32) {
      log.warn(`downloadAndDecrypt: skey 长度异常 ${key.length} 字节（应为32），直接保存密文`);
      return ciphertext;
    }
    const nonce = ciphertext.subarray(0, 12);
    const tag = ciphertext.subarray(ciphertext.length - 16);
    const data = ciphertext.subarray(12, ciphertext.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    log.info(`downloadAndDecrypt: AES-256-GCM 解密成功 ${msgId} ${ciphertext.length}B -> ${plain.length}B`);
    return plain;
  } catch (e) {
    log.error(`downloadAndDecrypt: AES 解密失败 ${msgId}: ${e}`);
    return null;
  }
}

/**
 * 按消息 ID 解密加密图片（msgType=91，阅后即焚/永久加密）
 *
 * 从数据库查询消息，走 read_once/detail 路径解密。
 * 永久图片和阅后即焚都走此路径（统一处理）。
 *
 * @param msgId 消息 ID（serverMsgId 或 msgId）
 * @param conversationId 会话 ID
 * @param conversationShortId 会话短 ID
 * @param accountName 账号名
 */
export async function decryptImageForMessage(
  msgId: string,
  conversationId: string,
  conversationShortId: string,
  accountName?: string,
): Promise<string | null> {
  const account = accountName || (await getCurrentAccount()) || '';
  if (!account) {
    log.error('decryptImageForMessage: 无法确定当前账号');
    return null;
  }

  // 从数据库查询消息（仅用于缓存检查，解密路径统一走 read_once/detail）
  const row = getMessageById(account, msgId);
  if (!row) {
    log.warn(`decryptImageForMessage: 数据库中未找到消息 ${msgId}`);
  }

  return decryptImage(msgId, conversationId, conversationShortId, accountName);
}

/** 检测图片格式，返回扩展名（不带点） */
function detectImageExt(buf: Buffer): string {
  if (buf.length < 12) return 'bin';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  return 'bin';
}
