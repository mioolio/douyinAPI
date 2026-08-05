/**
 * 浏览器扫码登录并保存 storageState
 *
 * 流程：
 *   1. 启动 headful 浏览器
 *   2. 若已有同名账号则加载旧 storageState（保留上次登录态，可能直接是已登录状态）
 *   3. 打开抖音聊天页，等待用户扫码登录
 *   4. 监测 URL 出现 chat 页 + 关键 cookie（sessionid）出现即视为登录成功
 *   5. 导出 storageState 保存到 data/accounts/<name>.json
 *   6. 自动设置为当前账号
 *
 * 用法：
 *   npx tsx src/commands/login.ts <name>
 *   sprr login <name>
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import { DOUYIN_CHAT_URL, } from '../config/paths.js';
import { accountFile, saveAccountStorageState, setCurrentAccount } from '../auth/accounts.js';
import { createLogger } from '../utils/logger.js';
const log = createLogger('login');
/** 检查 storageState 中是否包含 sessionid cookie（判断登录态） */
function hasSessionid(state) {
    return Boolean(state.cookies?.some((c) => c.name === 'sessionid' && c.value));
}
/**
 * 启动浏览器扫码登录并保存为指定账号
 *
 * @param name 账号名
 * @param options.headless 是否无头模式（默认 false，登录必须 headful）
 * @param options.timeout 登录超时（毫秒，默认 5 分钟）
 */
export async function loginAccount(name, options = {}) {
    const headless = options.headless ?? false;
    const timeout = options.timeout ?? 5 * 60 * 1000;
    log.info(`启动浏览器登录账号: ${name}`);
    if (headless) {
        log.warn('headless 模式下无法扫码，仅用于复用已有 storageState 测试');
    }
    // 已有同名账号：加载旧 storageState 作为初始状态
    let existingState;
    try {
        await fs.access(accountFile(name));
        existingState = accountFile(name);
        log.info(`检测到已有账号 ${name}，加载旧 storageState（如果是已登录状态可直接使用）`);
    }
    catch {
        // 无旧账号
    }
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext(existingState
        ? { storageState: existingState }
        : {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            viewport: { width: 1400, height: 900 },
            locale: 'zh-CN',
        });
    const page = await context.newPage();
    await page.goto(DOUYIN_CHAT_URL);
    log.info('请在打开的浏览器中扫码登录抖音（如已登录会自动跳过）...');
    log.info(`等待登录完成（超时 ${Math.floor(timeout / 1000)} 秒）`);
    // 轮询检测登录态：URL 在 chat 页 + sessionid cookie 出现
    const startTime = Date.now();
    let loggedIn = false;
    while (Date.now() - startTime < timeout) {
        await page.waitForTimeout(2000);
        try {
            const state = await context.storageState();
            if (hasSessionid(state)) {
                // 进一步确认 URL 在 douyin.com 域下（避免登录跳转中途保存）
                const url = page.url();
                if (url.includes('douyin.com')) {
                    loggedIn = true;
                    log.info('检测到 sessionid，登录成功！');
                    // 等待 2 秒让页面其他 cookie（msToken 等）写入
                    await page.waitForTimeout(2000);
                    break;
                }
            }
        }
        catch {
            // 忽略
        }
    }
    if (!loggedIn) {
        await browser.close();
        throw new Error('登录超时，未检测到 sessionid cookie');
    }
    // 导出最终 storageState
    const finalState = await context.storageState();
    await browser.close();
    await saveAccountStorageState(name, finalState);
    // 自动设为当前账号
    await setCurrentAccount(name);
    const cookieCount = finalState.cookies?.length || 0;
    const uid = finalState.cookies?.find((c) => c.name === 'uid_tt')?.value;
    log.info(`登录完成：账号 ${name}，共 ${cookieCount} 个 cookie，uid_tt=${uid || '?'}`);
    log.info(`已自动设为当前账号，可直接使用 sprr list / sprr history 等命令`);
}
/** 仅列出当前所有账号（CLI 的 accounts 命令用） */
export async function listAccountsInfo() {
    const { listAccounts, getCurrentAccount } = await import('../auth/accounts.js');
    const accounts = await listAccounts();
    const current = await getCurrentAccount();
    if (accounts.length === 0) {
        log.info('暂无账号。使用 `sprr login <name>` 登录第一个账号');
        return;
    }
    log.info(`共 ${accounts.length} 个账号（* 标记当前账号）:`);
    for (const a of accounts) {
        const mark = a.name === current ? '*' : ' ';
        const time = new Date(a.savedAt).toLocaleString('zh-CN', { hour12: false });
        const sessionTag = a.hasSessionid ? '已登录' : '无sessionid';
        log.info(`  ${mark} ${a.name.padEnd(20)} uid=${a.uid || '?'.padEnd(20)} [${sessionTag}] 保存于 ${time}`);
    }
}
