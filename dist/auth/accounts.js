/**
 * 账号管理（多账号切换）
 *
 * 存储结构：
 *   data/accounts/
 *     <name>.json   每个账号一个 storageState 文件（Playwright 格式）
 *     current       纯文本文件，记录当前账号名
 *
 * 优先级：
 *   1. --state <path>          直接指定 storageState 路径（最高优先级，向后兼容）
 *   2. --account <name>        临时使用指定账号（不修改 current 指针）
 *   3. data/accounts/current   当前默认账号
 *   4. DEFAULT_STORAGE_STATE   兜底（../ccc/data/storageState.json）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ACCOUNTS_DIR, CURRENT_ACCOUNT_FILE, DEFAULT_STORAGE_STATE, } from '../config/paths.js';
import { createLogger } from '../utils/logger.js';
const log = createLogger('accounts');
/** 账号名只允许字母数字下划线中横线（防止路径穿越） */
export function validateAccountName(name) {
    if (!name || typeof name !== 'string') {
        throw new Error('账号名不能为空');
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
        throw new Error(`账号名非法: ${name}（只允许字母数字下划线中横线，长度 1-64）`);
    }
    if (name === 'current') {
        throw new Error(`账号名不能为 "current"（保留字）`);
    }
}
/** 账号 storageState 文件路径 */
export function accountFile(name) {
    validateAccountName(name);
    return path.join(ACCOUNTS_DIR, `${name}.json`);
}
/** 列出所有已保存账号 */
export async function listAccounts() {
    await fs.mkdir(ACCOUNTS_DIR, { recursive: true });
    const entries = await fs.readdir(ACCOUNTS_DIR);
    const accounts = [];
    for (const entry of entries) {
        if (!entry.endsWith('.json'))
            continue;
        const name = entry.slice(0, -5);
        const file = path.join(ACCOUNTS_DIR, entry);
        try {
            const stat = await fs.stat(file);
            const raw = await fs.readFile(file, 'utf-8');
            const j = JSON.parse(raw);
            const cookies = j.cookies || [];
            const uid = cookies.find((c) => c.name === 'uid_tt')?.value;
            const hasSessionid = cookies.some((c) => c.name === 'sessionid');
            accounts.push({
                name,
                file,
                savedAt: stat.mtimeMs,
                size: stat.size,
                uid,
                hasSessionid,
            });
        }
        catch {
            // 解析失败的文件跳过
        }
    }
    accounts.sort((a, b) => b.savedAt - a.savedAt);
    return accounts;
}
/** 读取当前账号指针 */
export async function getCurrentAccount() {
    try {
        const name = (await fs.readFile(CURRENT_ACCOUNT_FILE, 'utf-8')).trim();
        if (!name)
            return null;
        // 校验文件确实存在（指针可能过期）
        try {
            await fs.access(accountFile(name));
            return name;
        }
        catch {
            return null;
        }
    }
    catch {
        return null;
    }
}
/** 设置当前账号指针 */
export async function setCurrentAccount(name) {
    validateAccountName(name);
    const file = accountFile(name);
    try {
        await fs.access(file);
    }
    catch {
        throw new Error(`账号不存在: ${name}（先用 sprr login ${name} 登录）`);
    }
    await fs.mkdir(ACCOUNTS_DIR, { recursive: true });
    await fs.writeFile(CURRENT_ACCOUNT_FILE, name, 'utf-8');
    log.info(`当前账号已切换为: ${name}`);
}
/** 删除指定账号 */
export async function deleteAccount(name) {
    validateAccountName(name);
    const file = accountFile(name);
    try {
        await fs.unlink(file);
    }
    catch (e) {
        if (e.code === 'ENOENT') {
            throw new Error(`账号不存在: ${name}`);
        }
        throw e;
    }
    // 如果删除的是当前账号，清空指针
    const current = await getCurrentAccount();
    if (current === name) {
        try {
            await fs.unlink(CURRENT_ACCOUNT_FILE);
        }
        catch {
            // ignore
        }
    }
    log.info(`账号已删除: ${name}`);
}
/**
 * 解析最终使用的 storageState 路径
 *
 * @param statePath --state 选项
 * @param accountName --account 选项
 * @returns { path, source } source 说明来源
 */
export async function resolveStorageState(statePath, accountName) {
    if (statePath) {
        return { path: path.resolve(statePath), source: '--state' };
    }
    if (accountName) {
        validateAccountName(accountName);
        const file = accountFile(accountName);
        try {
            await fs.access(file);
        }
        catch {
            throw new Error(`账号不存在: ${accountName}（先用 sprr login ${accountName} 登录）`);
        }
        return { path: file, source: `--account ${accountName}` };
    }
    const current = await getCurrentAccount();
    if (current) {
        return { path: accountFile(current), source: `当前账号 ${current}` };
    }
    return { path: DEFAULT_STORAGE_STATE, source: '默认兜底（../ccc/data/storageState.json）' };
}
/** 保存 storageState 到指定账号文件 */
export async function saveAccountStorageState(name, storageState) {
    validateAccountName(name);
    await fs.mkdir(ACCOUNTS_DIR, { recursive: true });
    const file = accountFile(name);
    await fs.writeFile(file, JSON.stringify(storageState, null, 2), 'utf-8');
    log.info(`账号 ${name} 已保存到 ${file}`);
}
