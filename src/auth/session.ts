/**
 * Session 管理（cookie / token 持久化）
 *
 * 抖音 Web 端登录态主要靠 cookie 维持，关键 cookie：
 * - sessionid：登录会话 ID
 * - sessionid_ss：sessionid 的 secure 版本
 * - uid_tt / uid_tt_ss：用户 ID
 * - sid_tt：session ID（与 sessionid 不同）
 * - passport_csrf_token：CSRF 防护
 * - ttwid：设备标识（未登录也有）
 * - msToken：风控 token
 *
 * 这些 cookie 来自登录或首次访问，需要持久化以便后续 API 调用复用。
 */

import fs from 'node:fs/promises';
import { SESSION_FILE, DATA_DIR } from '../config/paths.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('session');

/** 持久化的 session 数据结构 */
export interface SessionData {
  /** Cookie 字符串（可直接用于 HTTP Cookie header） */
  cookie: string;
  /** 按 name 索引的 cookie 对象 */
  cookies: Record<string, string>;
  /** 用户 ID（uid） */
  uid?: string;
  /** 用户昵称 */
  nickname?: string;
  /** sec_uid */
  secUid?: string;
  /** 保存时间（毫秒时间戳） */
  savedAt: number;
}

/**
 * 读取本地 session
 *
 * @returns session 数据，文件不存在或解析失败返回 null
 */
export async function loadSession(): Promise<SessionData | null> {
  try {
    const raw = await fs.readFile(SESSION_FILE, 'utf-8');
    const data = JSON.parse(raw) as SessionData;
    log.debug(`已加载 session（保存于 ${new Date(data.savedAt).toLocaleString()}）`);
    return data;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('读取 session 文件失败', e);
    }
    return null;
  }
}

/**
 * 保存 session 到本地
 */
export async function saveSession(data: Omit<SessionData, 'savedAt'>): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const full: SessionData = { ...data, savedAt: Date.now() };
  await fs.writeFile(SESSION_FILE, JSON.stringify(full, null, 2), 'utf-8');
  log.info('session 已保存');
}

/**
 * 清除本地 session
 */
export async function clearSession(): Promise<void> {
  try {
    await fs.unlink(SESSION_FILE);
    log.info('session 已清除');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('清除 session 失败', e);
    }
  }
}

/**
 * 检查 session 是否存在
 */
export async function hasSession(): Promise<boolean> {
  try {
    await fs.access(SESSION_FILE);
    return true;
  } catch {
    return false;
  }
}

/**
 * 从 cookie 字符串解析为 cookies 对象
 */
export function parseCookieString(cookieStr: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of cookieStr.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) {
      const name = part.slice(0, idx).trim();
      const value = part.slice(idx + 1).trim();
      result[name] = value;
    }
  }
  return result;
}

/**
 * 从 cookies 对象构造 cookie 字符串
 */
export function buildCookieString(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * 从浏览器导出的 cookie 数组（如 Playwright storageState 格式）导入
 *
 * 适用场景：用户手动从浏览器导出 cookie 后导入。
 */
export async function importFromCookieArray(
  cookies: Array<{ name: string; value: string; domain?: string }>,
): Promise<SessionData> {
  const cookiesMap: Record<string, string> = {};
  for (const c of cookies) {
    cookiesMap[c.name] = c.value;
  }
  const session: SessionData = {
    cookie: buildCookieString(cookiesMap),
    cookies: cookiesMap,
    uid: cookiesMap['uid_tt'] || cookiesMap['s_v_web_id'],
    savedAt: Date.now(),
  };
  await saveSession(session);
  return session;
}

/**
 * 从 Playwright storageState 文件加载 session
 *
 * storageState.json 格式：{ cookies: [{name, value, domain, path, ...}], origins: [...] }
 * 仅取 .douyin.com 域下的 cookie，构造可直接用于 HTTP Cookie header 的字符串。
 *
 * @param storageStatePath storageState.json 文件路径
 * @returns session 数据（不保存到 SESSION_FILE，调用方决定是否持久化）
 */
export async function loadFromStorageState(
  storageStatePath: string,
): Promise<SessionData> {
  const raw = await fs.readFile(storageStatePath, 'utf-8');
  const j = JSON.parse(raw) as { cookies?: Array<{ name: string; value: string; domain?: string }> };
  if (!j.cookies || !Array.isArray(j.cookies)) {
    throw new Error(`storageState 文件无 cookies 字段: ${storageStatePath}`);
  }
  const cookiesMap: Record<string, string> = {};
  for (const c of j.cookies) {
    // 跳过空名 cookie（域名弹跳页可能写入 name="" value="douyin.com" 的脏数据，
    // 会构造出 "=douyin.com;" 的畸形 Cookie 头，导致服务器解析失败）
    if (!c.name) continue;
    // 仅取 .douyin.com 域（避免其他域的 cookie 干扰）
    const domain = c.domain || '';
    if (!domain.includes('douyin.com')) continue;
    cookiesMap[c.name] = c.value;
  }
  if (Object.keys(cookiesMap).length === 0) {
    throw new Error(`storageState 中未找到 .douyin.com 域的 cookie`);
  }
  const session: SessionData = {
    cookie: buildCookieString(cookiesMap),
    cookies: cookiesMap,
    uid: cookiesMap['uid_tt'],
    savedAt: Date.now(),
  };
  log.info(
    `从 storageState 加载 ${Object.keys(cookiesMap).length} 个 cookie（uid_tt=${cookiesMap['uid_tt'] || '?'}, sessionid=${cookiesMap['sessionid'] ? '有' : '无'}）`,
  );
  return session;
}

// 重新导出路径常量方便外部使用
export { SESSION_FILE } from '../config/paths.js';
