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
  listContacts,
  buildPrivateCid,
  detectMyUid,
  type ContactItem,
} from '../api/operations.js';
import { getUserInfoMap } from '../api/webapi.js';

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
let _contactsCache: ContactItem[] | null = null;

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
  if (_session && _env) return { session: _session, env: _env };
  if (cliState.cookie) {
    log.debug('使用直接传入的 cookie 字符串（无需登录）');
    _session = sessionFromCookieString(cliState.cookie);
  } else {
    const { path: statePath, source } = await resolveStorageState(cliState.statePath, cliState.account);
    log.debug(`使用 storageState: ${statePath}（来源: ${source}）`);
    _session = await loadFromStorageState(statePath);
  }
  _env = envFromSession(_session);
  return { session: _session, env: _env };
}

/** 设置 cookie 字符串（REPL 内 cookie 命令调用），同时清除缓存 */
export function setCookie(cookieStr: string): void {
  cliState.cookie = cookieStr;
  clearCache();
}

/**
 * 清除缓存（切换账号 / reload 命令时调用）
 *
 * 同时关闭常驻浏览器实例，避免旧会话的浏览器被复用。
 */
export function clearCache(): void {
  _session = null;
  _env = null;
  _contactsCache = null;
  // 关闭常驻浏览器单例（切换账号后 storageState 变了，旧浏览器不能复用）
  void closeBrowserSenderSafe();
}

// 延迟导入避免循环依赖：browser-pool 会被命令模块使用，
// 而 context.ts 不应直接依赖命令层。这里用动态导入兜底。
async function closeBrowserSenderSafe(): Promise<void> {
  try {
    const { closeBrowserSender } = await import('../commands/browser-pool.js');
    await closeBrowserSender();
  } catch {
    // 模块未加载时忽略
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
export async function getContacts(env: ReturnType<typeof envFromSession>): Promise<ContactItem[]> {
  if (!_contactsCache) {
    _contactsCache = await listContacts(env);
    const secUidsToFetch = _contactsCache
      .filter((c) => c.secUid && c.nickname === '(pending)')
      .map((c) => c.secUid!) as string[];
    if (secUidsToFetch.length > 0) {
      log.info(`getContacts: 批量获取 ${secUidsToFetch.length} 个用户的 nickname...`);
      const userInfoMap = await getUserInfoMap(env, secUidsToFetch);
      for (const c of _contactsCache) {
        if (!c.secUid) continue;
        const info = userInfoMap.get(c.secUid);
        if (info && info.nickname) {
          c.nickname = info.nickname;
        } else if (c.nickname === '(pending)') {
          c.nickname = `(uid:${c.uid.slice(-6)})`;
        }
      }
    }
  }
  return _contactsCache;
}

// ============================ 目标解析 ============================

/** 解析目标用户 */
export async function resolveTarget(
  env: ReturnType<typeof envFromSession>,
  target: string,
  myUid: string,
  contacts: ContactItem[],
): Promise<{
  uid: string;
  nickname: string;
  conversationShortId: string;
  ticket?: string;
} | null> {
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
  let match = contacts.find((c) => c.nickname === target || c.remark === target);
  if (!match) {
    match = contacts.find(
      (c) => c.nickname.includes(target) || (c.remark && c.remark.includes(target)),
    );
  }
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
