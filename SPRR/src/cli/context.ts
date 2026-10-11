/**
 * CLI 共享上下文
 *
 * 全局状态、session 缓存、联系人缓存，以及复用 helper：
 * ensureSession / run / getContacts / resolveTarget / getStatePathForBrowser 等。
 * 从 indexv2.ts 抽取，供所有命令模块复用。
 */

import path from 'node:path';
import fs from 'node:fs/promises';

import { createLogger } from '../utils/logger.js';
import { DATA_DIR } from '../config/paths.js';
import {
  loadFromStorageState,
  sessionFromCookieString,
  type SessionData,
} from '../auth/session.js';
import { resolveStorageState } from '../auth/accounts.js';
import {
  envFromSession,
  listContactsResult,
  buildPrivateCid,
  detectMyUid,
  type ContactItem,
} from '../api/operations.js';
import { getUserInfoMap } from '../api/webapi.js';
import { ContactCache } from './contact-cache.js';
import { accountCacheKey, clearMessageCache, getCachedMessage } from './message-cache.js';
export { cacheMessages, getCachedMessage, markMessageRecalled, isMessageRecalled } from './message-cache.js';

const log = createLogger('cli-ctx');

const ALIAS_FILE = path.join(DATA_DIR, 'aliases.json');

// ============================ 全局状态 ============================

export const cliState = {
  verbose: false,
  json: false,
  statePath: undefined as string | undefined,
  account: undefined as string | undefined,
  cookie: undefined as string | undefined,
};

/** 缓存的 session（首次命令加载后复用） */
let _session: SessionData | null = null;
let _env: ReturnType<typeof envFromSession> | null = null;
/** 缓存的联系人列表 */
let _sessionKey: string | null = null;
let _currentConversation: ContactItem | null = null;
let _lastContactList: ContactItem[] = [];
let _sessionGeneration = 0;
const contactsCache = new ContactCache({
  fetchContacts: listContactsResult,
  fetchNames: getUserInfoMap,
  fetchSelfUid: async (env) => (await (await import('../commands/profile.js')).getSelfProfile(env)).uid,
});

export interface SessionSource { statePath?: string; account?: string; cookie?: string }
let persistentSource: SessionSource = {};

export function getDefaultSessionSource(): SessionSource {
  return { ...persistentSource };
}

export async function setSessionSource(source: SessionSource, persistent = true): Promise<void> {
  if (persistent) persistentSource = { ...source };
  const changed = cliState.statePath !== source.statePath || cliState.account !== source.account || cliState.cookie !== source.cookie;
  cliState.statePath = source.statePath;
  cliState.account = source.account;
  cliState.cookie = source.cookie;
  if (changed) await clearCache();
}

/** Global account overrides apply to one command; cookie/use commands set the REPL default. */
export async function applyCommandSessionSource(options: { state?: string; account?: string; cookie?: string }): Promise<void> {
  const source: SessionSource = options.cookie ? { cookie: options.cookie }
    : options.state ? { statePath: options.state }
    : options.account ? { account: options.account } : persistentSource;
  await setSessionSource(source, false);
}

export async function restoreCommandSessionSource(): Promise<void> {
  await setSessionSource(persistentSource, false);
}

// ============================ 别名管理 ============================

export async function loadAliases(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(ALIAS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function saveAliases(aliases: Record<string, string>): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(ALIAS_FILE, JSON.stringify(aliases, null, 2), 'utf-8');
}

// ============================ Session 缓存 ============================

/** 加载并缓存 session，后续命令复用 */
export async function ensureSession(): Promise<{
  session: SessionData;
  env: ReturnType<typeof envFromSession>;
}> {
  let statePath: string | undefined;
  let sourceKey: string;
  if (cliState.cookie) {
    sourceKey = `cookie:${accountCacheKey({ cookie: cliState.cookie })}`;
  } else {
    const resolved = await resolveStorageState(cliState.statePath, cliState.account);
    statePath = resolved.path;
    const stat = await fs.stat(statePath);
    sourceKey = `${path.resolve(statePath)}:${stat.mtimeMs}:${stat.size}`;
  }
  if (_session && _env && _sessionKey === sourceKey) return { session: _session, env: _env };
  if (_sessionKey !== null) await clearCache();
  if (cliState.cookie) {
    log.debug('使用直接传入的 cookie 字符串（无需登录）');
    _session = sessionFromCookieString(cliState.cookie);
  } else {
    log.debug(`使用 storageState: ${statePath}`);
    _session = await loadFromStorageState(statePath!);
  }
  _sessionKey = sourceKey;
  _env = envFromSession(_session);
  return { session: _session, env: _env };
}

/** 设置 cookie 字符串（REPL 内 cookie 命令调用），同时清除缓存 */
export async function setCookie(cookieStr: string): Promise<void> {
  await setSessionSource({ cookie: cookieStr });
}

/**
 * 清除缓存（切换账号 / reload 命令时调用）
 *
 * 同时关闭常驻浏览器实例，避免旧会话的浏览器被复用。
 */
export async function clearCache(): Promise<void> {
  _sessionGeneration++;
  _session = null;
  _env = null;
  _sessionKey = null;
  _currentConversation = null;
  _lastContactList = [];
  contactsCache.clear();
  clearMessageCache();
  // 关闭常驻浏览器单例（切换账号后 storageState 变了，旧浏览器不能复用）
  await closeBrowserSenderSafe();
}

// 延迟导入避免循环依赖：browser-pool 会被命令模块使用，
// 而 context.ts 不应直接依赖命令层。这里用动态导入兜底。
async function closeBrowserSenderSafe(): Promise<void> {
  try {
    const { closeBrowserSender } = await import('../commands/browser-pool.js');
    await closeBrowserSender();
  } catch (error) {
    log.warn('关闭浏览器失败', error);
  }
}

/**
 * 获取用于浏览器相关功能的 storageState 文件路径
 *
 * 在 --cookie 模式下，把 cookie 字符串写成临时 storageState 文件，
 * 让依赖浏览器的功能也能工作。
 */
export async function getStatePathForBrowser(): Promise<string> {
  if (cliState.cookie) {
    const tmpPath = path.join(DATA_DIR, 'tmp-cookie-state.json');
    const cookies = cliState.cookie
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => {
        const idx = pair.indexOf('=');
        const name = idx > 0 ? pair.slice(0, idx) : pair;
        const value = idx > 0 ? pair.slice(idx + 1) : '';
        return {
          name,
          value,
          domain: '.douyin.com',
          path: '/',
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: 'Lax' as const,
        };
      });
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(tmpPath, JSON.stringify({ cookies, origins: [] }, null, 2), 'utf-8');
    return tmpPath;
  }
  const { path: statePath } = await resolveStorageState(cliState.statePath, cliState.account);
  return statePath;
}

/** 加载 session 并执行回调（复用缓存） */
export async function run(
  fn: (ctx: { env: ReturnType<typeof envFromSession>; session: SessionData }) => Promise<void>,
): Promise<void> {
  try {
    const { env, session } = await ensureSession();
    await fn({ env, session });
  } catch (e) {
    log.error('执行失败', e);
  }
}

// ============================ 联系人缓存 ============================

/** 获取联系人列表（缓存） */
export async function getContacts(
  env: ReturnType<typeof envFromSession>,
  options: { refresh?: boolean; refreshStrangers?: boolean } = {},
): Promise<ContactItem[]> {
  const result = await contactsCache.get(accountCacheKey(env), env, {
    refreshRegular: options.refresh,
    refreshStrangers: options.refreshStrangers,
  });
  if (result.identityError) log.warn(`当前账号身份未确认：${result.identityError}`);
  for (const failure of result.failures) {
    log.warn(`${failure.source === 'stranger' ? '陌生人会话' : '常规会话'}查询未完成：${failure.error}${result.stale ? '；保留此前可用数据' : ''}`);
  }
  if (result.contacts.length === 0 && !result.complete) {
    throw new Error('联系人查询失败，不能将失败结果视为空会话列表；请稍后重试');
  }
  return result.contacts;
}

/** Never guess the sender in a tied/single-conversation list. */
export function getMyUid(env: ReturnType<typeof envFromSession>): string {
  const uid = contactsCache.getMyUid(accountCacheKey(env));
  if (!uid) throw new Error('无法确定当前账号数字 UID，不能操作会话；请刷新 list 后重试');
  return uid;
}

export function getCurrentConversation(): ContactItem | null {
  return _currentConversation ? { ..._currentConversation } : null;
}
export function setCurrentConversation(contact: ContactItem): void {
  _currentConversation = { ...contact };
}
export function recordContactList(contacts: ContactItem[]): void {
  _lastContactList = contacts.map((contact) => ({ ...contact }));
}
export function resolveCommandTargetName(target?: string): string | null {
  return target?.trim() || _currentConversation?.conversationId || null;
}

/** Read only the already-loaded account cache; missing targets must not trigger authentication. */
export function getCachedReference(id: string) {
  return _env ? getCachedMessage(_env, id) : null;
}

export interface CommandTargetSelection {
  name: string;
  implicit: boolean;
  sessionGeneration: number;
}

/** Capture a local selection without loading credentials; verify it again after run loads the session. */
export function captureCommandTarget(target?: string, referenceId?: string): CommandTargetSelection | null {
  const explicit = target?.trim();
  const name = explicit || (referenceId ? getCachedReference(referenceId)?.cid : undefined) || _currentConversation?.conversationId;
  return name ? { name, implicit: !explicit, sessionGeneration: _sessionGeneration } : null;
}

export function confirmCommandTarget(selection: CommandTargetSelection): string {
  if (selection.implicit && selection.sessionGeneration !== _sessionGeneration) {
    throw new Error('登录态已变化，之前选择的会话已失效；请重新运行 history --to <目标>，或显式指定 --to');
  }
  return selection.name;
}

// ============================ 目标解析 ============================

/** 解析目标用户 */
export async function resolveTarget(
  env: ReturnType<typeof envFromSession>,
  target: string | undefined,
  myUid: string,
  contacts: ContactItem[],
): Promise<{
  uid: string;
  nickname: string;
  conversationShortId: string;
  ticket?: string;
} | null> {
  const selected = resolveCommandTargetName(target);
  if (!selected) throw new Error('请先用 history --to <用户> 选择会话，或显式指定 --to <用户>');
  target = selected;
  if (/^#\d+$/.test(target)) {
    const contact = _lastContactList[Number(target.slice(1)) - 1];
    if (!contact) throw new Error(`无效会话序号 ${target}；请先运行 list，再使用 --to #序号`);
    target = contact.conversationId;
  }
  if (/^\d+$/.test(target)) {
    const c = contacts.find((x) => x.uid === target);
    if (c && c.conversationShortId) {
      return {
        uid: c.uid,
        nickname: c.nickname,
        conversationShortId: c.conversationShortId,
        ticket: c.remark,
      };
    }
    log.error(`uid ${target} 不在会话列表中，无法获取 conversation_short_id`);
    return null;
  }
  if (target.startsWith('0:1:')) {
    const c = contacts.find((x) => x.conversationId === target);
    if (c && c.conversationShortId) {
      return {
        uid: c.uid,
        nickname: c.nickname,
        conversationShortId: c.conversationShortId,
        ticket: c.remark,
      };
    }
  }
  let matches = contacts.filter((c) => c.nickname === target || c.remark === target);
  if (matches.length === 0) {
    matches = contacts.filter(
      (c) => c.nickname.includes(target) || (c.remark && c.remark.includes(target)),
    );
  }
  if (matches.length > 1) {
    throw new Error(`目标“${target}”匹配多个会话：${matches.map((c) => `${c.nickname} (UID ${c.uid})`).join('、')}；请使用 UID 或会话 ID`);
  }
  const match = matches[0];
  if (match && match.conversationShortId) {
    return {
      uid: match.uid,
      nickname: match.nickname,
      conversationShortId: match.conversationShortId,
      ticket: match.remark,
    };
  }
  return null;
}

export { buildPrivateCid, detectMyUid };
