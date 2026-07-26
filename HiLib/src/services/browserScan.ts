/**
 * 浏览器 Cookie 扫描器
 *
 * 直接读取 Chrome / Edge 的 cookie 数据库并解密，
 * 无需关闭浏览器（先复制数据库文件再读取）。
 *
 * 解密流程：
 *   1. 读取 User Data\Local State 中的 os_crypt.encrypted_key（Base64）
 *   2. 去掉前 5 字节 "DPAPI" 标记，用 Windows DPAPI 解密得到 master key（32 字节）
 *   3. 每个 cookie 的 encrypted_value 前 3 字节是 "v10"/"v11" 标记，
 *      后面是 12 字节 nonce + 密文 + 16 字节 GCM tag
 *   4. 用 master key + nonce 通过 AES-256-GCM 解密
 *
 * 仅 Windows 可用。
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { createLogger } from '../sprr/utils/logger.js';

const log = createLogger('browser-scan');

/** 浏览器配置 */
interface BrowserConfig {
  name: string;
  userDataDir: string;
}

/** 扫描到的账号 */
export interface ScannedAccount {
  /** 来源浏览器名（Chrome / Edge） */
  browser: string;
  /** 来源 Profile 名（Default / Profile 1 等） */
  profile: string;
  /** uid_tt cookie 值（作为账号标识） */
  uid: string;
  /** sessionid cookie 值 */
  sessionid: string;
  /** 是否包含 sessionid（判断登录态） */
  hasSessionid: boolean;
  /** 完整 cookie 键值对（已解密） */
  cookies: Record<string, string>;
}

/** 获取本机已安装的浏览器 */
function detectBrowsers(): BrowserConfig[] {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates: BrowserConfig[] = [
    { name: 'Chrome', userDataDir: path.join(localAppData, 'Google', 'Chrome', 'User Data') },
    { name: 'Edge', userDataDir: path.join(localAppData, 'Microsoft', 'Edge', 'User Data') },
  ];
  return candidates.filter((b) => fsSync.existsSync(b.userDataDir));
}

/** 列出浏览器下所有 Profile 目录 */
async function listProfiles(userDataDir: string): Promise<string[]> {
  const profiles: string[] = [];
  // Default profile
  if (fsSync.existsSync(path.join(userDataDir, 'Default'))) {
    profiles.push('Default');
  }
  // Profile 1, Profile 2, ...
  const entries = await fs.readdir(userDataDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (/^Profile \d+$/.test(entry.name)) {
      profiles.push(entry.name);
    }
  }
  return profiles;
}

/** 查找 cookie 数据库文件路径（兼容新旧位置） */
function findCookieDb(userDataDir: string, profile: string): string | null {
  // 新版位置：User Data\<profile>\Network\Cookies
  const newPath = path.join(userDataDir, profile, 'Network', 'Cookies');
  if (fsSync.existsSync(newPath)) return newPath;
  // 旧版位置：User Data\<profile>\Cookies
  const oldPath = path.join(userDataDir, profile, 'Cookies');
  if (fsSync.existsSync(oldPath)) return oldPath;
  return null;
}

/** 读取 Local State 并解密 master key */
async function getMasterKey(userDataDir: string): Promise<Buffer> {
  const localStatePath = path.join(userDataDir, 'Local State');
  const raw = await fs.readFile(localStatePath, 'utf-8');
  const j = JSON.parse(raw) as { os_crypt?: { encrypted_key?: string } };
  const encryptedKeyB64 = j.os_crypt?.encrypted_key;
  if (!encryptedKeyB64) {
    throw new Error('Local State 中未找到 os_crypt.encrypted_key');
  }
  // Base64 解码
  const encryptedKey = Buffer.from(encryptedKeyB64, 'base64');
  // 前 5 字节是 "DPAPI" 标记
  if (encryptedKey.length < 5 || encryptedKey.slice(0, 5).toString('utf-8') !== 'DPAPI') {
    throw new Error('encrypted_key 格式异常（缺少 DPAPI 标记）');
  }
  const dpapiBlob = encryptedKey.slice(5);
  // 用 PowerShell 调用 Windows DPAPI 解密
  return dpapiUnprotect(dpapiBlob);
}

/** 用 PowerShell 解密 DPAPI 数据 */
function dpapiUnprotect(encrypted: Buffer): Buffer {
  const b64Input = encrypted.toString('base64');
  // PowerShell 脚本：用 CurrentUser scope 解密
  const script = `
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String('${b64Input}')
$decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::OpenStandardOutput().Write($decrypted, 0, $decrypted.Length)
`;
  // 用 execFileSync 直接拿二进制输出
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.length !== 32) {
    throw new Error(`DPAPI 解密后 master key 长度异常: ${result.length}（期望 32）`);
  }
  return result;
}

/** 用 master key 解密单个 cookie 的 encrypted_value */
function decryptCookieValue(encryptedValue: Buffer, masterKey: Buffer): string {
  // 前 3 字节是 "v10" 或 "v11" 标记
  const tag = encryptedValue.slice(0, 3).toString('utf-8');
  if (tag !== 'v10' && tag !== 'v11') {
    // 旧版可能未加密，直接返回
    return encryptedValue.toString('utf-8');
  }
  const nonce = encryptedValue.slice(3, 3 + 12); // 12 字节 nonce
  const ciphertextWithTag = encryptedValue.slice(3 + 12); // 密文 + 16 字节 GCM tag
  // AES-256-GCM 解密
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey, nonce);
  // GCM tag 在密文末尾 16 字节
  const tag2 = ciphertextWithTag.slice(ciphertextWithTag.length - 16);
  const ciphertext = ciphertextWithTag.slice(0, ciphertextWithTag.length - 16);
  decipher.setAuthTag(tag2);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf-8');
}

/** 读取 cookie 数据库（先复制避免文件锁定） */
async function readCookieDb(
  dbPath: string,
  masterKey: Buffer,
): Promise<Array<{ name: string; value: string; domain: string; path: string }>> {
  // 复制到临时文件（浏览器运行时会锁定 SQLite -WAL 文件）
  const tmpDir = path.join(os.tmpdir(), `hilib-cookies-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpDbPath = path.join(tmpDir, 'Cookies');
  // 复制主数据库 + WAL + SHM（如果存在）
  await fs.copyFile(dbPath, tmpDbPath);
  for (const suffix of ['-wal', '-shm']) {
    const src = dbPath + suffix;
    if (fsSync.existsSync(src)) {
      await fs.copyFile(src, tmpDbPath + suffix);
    }
  }

  try {
    const db = new Database(tmpDbPath, { readonly: true, fileMustExist: true });
    const rows = db
      .prepare(
        `SELECT name, encrypted_value, host_key, path
         FROM cookies
         WHERE host_key LIKE '%douyin.com'`,
      )
      .all() as Array<{ name: string; encrypted_value: Buffer; host_key: string; path: string }>;

    db.close();

    return rows.map((row) => ({
      name: row.name,
      value: decryptCookieValue(row.encrypted_value, masterKey),
      domain: row.host_key,
      path: row.path,
    }));
  } finally {
    // 清理临时文件
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * 扫描所有浏览器的抖音账号
 *
 * 返回按 sessionid 去重的账号列表（同一 sessionid 只保留一条）。
 */
export async function scanBrowserAccounts(): Promise<ScannedAccount[]> {
  const browsers = detectBrowsers();
  log.info(`检测到浏览器: ${browsers.map((b) => b.name).join(', ') || '无'}`);

  const accounts: ScannedAccount[] = [];
  const seenSessionids = new Set<string>();

  for (const browser of browsers) {
    let masterKey: Buffer;
    try {
      masterKey = await getMasterKey(browser.userDataDir);
      log.info(`${browser.name}: master key 解密成功`);
    } catch (e) {
      log.warn(`${browser.name}: master key 解密失败 - ${e instanceof Error ? e.message : e}`);
      continue;
    }

    const profiles = await listProfiles(browser.userDataDir);
    log.info(`${browser.name}: 发现 ${profiles.length} 个 Profile - ${profiles.join(', ')}`);

    for (const profile of profiles) {
      const dbPath = findCookieDb(browser.userDataDir, profile);
      if (!dbPath) {
        log.debug(`${browser.name}/${profile}: 无 cookie 数据库`);
        continue;
      }

      let cookies: Array<{ name: string; value: string; domain: string; path: string }>;
      try {
        cookies = await readCookieDb(dbPath, masterKey);
      } catch (e) {
        log.warn(`${browser.name}/${profile}: 读取 cookie 数据库失败 - ${e instanceof Error ? e.message : e}`);
        continue;
      }

      const douyinCookies = cookies.filter((c) => c.domain.endsWith('douyin.com'));
      if (douyinCookies.length === 0) continue;

      // 转成键值对
      const cookieMap: Record<string, string> = {};
      for (const c of douyinCookies) {
        // 同名 cookie 可能因 domain/path 不同而重复，保留最后一个
        cookieMap[c.name] = c.value;
      }

      const sessionid = cookieMap['sessionid'] || '';
      const uid = cookieMap['uid_tt'] || '';
      if (!sessionid) {
        log.debug(`${browser.name}/${profile}: 无 sessionid，跳过（未登录抖音）`);
        continue;
      }
      if (seenSessionids.has(sessionid)) {
        log.debug(`${browser.name}/${profile}: sessionid 已存在，跳过`);
        continue;
      }
      seenSessionids.add(sessionid);

      accounts.push({
        browser: browser.name,
        profile,
        uid,
        sessionid,
        hasSessionid: true,
        cookies: cookieMap,
      });
      log.info(`${browser.name}/${profile}: 发现抖音账号 uid=${uid || '?'}`);
    }
  }

  log.info(`扫描完成，共发现 ${accounts.length} 个抖音账号`);
  return accounts;
}

/**
 * 将扫描到的账号转为 Playwright storageState 格式
 */
export function toStorageState(account: ScannedAccount) {
  return {
    cookies: Object.entries(account.cookies).map(([k, v]) => ({
      name: k,
      value: v,
      domain: '.douyin.com',
      path: '/',
      httpOnly: false,
      secure: true,
      sameSite: 'Lax' as const,
    })),
    origins: [],
  };
}
