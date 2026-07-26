#!/usr/bin/env node
/**
 * SPRR - 抖音私信聊天自动化工具（纯 API 逆向版）
 *
 * 通过纯 Node.js HTTP + protobuf 实现，不启动浏览器：
 * - list    列出所有会话/联系人
 * - send    向指定用户发送文本消息
 * - send-image 向指定用户发送图片消息
 * - history 获取指定会话的聊天记录（支持分页拉取大量历史）
 *
 * 用法：
 *   sprr list
 *   sprr send --to TwT --text "你好"
 *   sprr send --to 1196717705541576 --text "在吗"
 *   sprr send-image --to TwT --image ./pic.jpg
 *   sprr history --to TwT --limit 100
 *   sprr history --to TwT --limit 500
 *
 * 选项：
 *   --json         以 JSON 格式输出（便于程序处理）
 *   --state <path> 指定 storageState 文件路径
 *   --verbose      输出详细调试日志
 */
import { Command } from 'commander';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { createLogger } from './utils/logger.js';
import { DATA_DIR } from './config/paths.js';
import { loadFromStorageState } from './auth/session.js';
import { resolveStorageState, listAccounts, getCurrentAccount, setCurrentAccount, deleteAccount, validateAccountName, } from './auth/accounts.js';
import { envFromSession, listContacts, sendMessage, sendImage, getHistoryAll, getHistory, buildPrivateCid, detectMyUid, } from './api/operations.js';
import { getUserInfoMap, getReadOnceImage, buildImageUrl } from './api/webapi.js';
import { uploadImage } from './api/tos.js';
const log = createLogger('cli');
/** 本地备注映射文件路径（uid -> nickname） */
const ALIAS_FILE = path.join(DATA_DIR, 'aliases.json');
/** 读取本地备注映射 */
async function loadAliases() {
    try {
        const raw = await fs.readFile(ALIAS_FILE, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
/** 保存本地备注映射 */
async function saveAliases(aliases) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(ALIAS_FILE, JSON.stringify(aliases, null, 2), 'utf-8');
}
let globalVerbose = false;
let globalJson = false;
let globalState;
let globalAccount;
const program = new Command();
program
    .name('sprr')
    .description('抖音私信聊天自动化工具（纯 API 逆向版）')
    .version('0.0.1')
    .option('--verbose', '输出详细日志（debug 级别）', false)
    .option('--json', '以 JSON 格式输出结果', false)
    .option('--state <path>', 'storageState 文件路径（优先级最高）', undefined)
    .option('--account <name>', '临时使用指定账号（不修改当前账号指针）', undefined)
    .hook('preAction', (cmd) => {
    const opts = program.opts();
    globalVerbose = Boolean(opts.verbose);
    globalJson = Boolean(opts.json);
    globalState = opts.state;
    globalAccount = opts.account;
    if (globalVerbose) {
        process.env.SPRR_DEBUG = '1';
    }
});
/* --------------------------- login 命令 --------------------------- */
program
    .command('login <name>')
    .description('启动浏览器扫码登录抖音，保存为指定账号（自动设为当前账号）')
    .option('--timeout <ms>', '登录超时毫秒数（默认 300000 = 5 分钟）', '300000')
    .action(async (name, opts) => {
    validateAccountName(name);
    const timeout = parseInt(opts.timeout, 10);
    // 动态导入 playwright，避免未安装时其他命令也加载失败
    let loginFn;
    try {
        const mod = await import('./commands/login.js');
        loginFn = mod.loginAccount;
    }
    catch (e) {
        log.error('加载登录模块失败（确保已安装 playwright: pnpm add -D playwright）', e);
        process.exitCode = 1;
        return;
    }
    try {
        await loginFn(name, { timeout });
    }
    catch (e) {
        log.error('登录失败', e);
        process.exitCode = 1;
    }
});
/* --------------------------- accounts 命令 --------------------------- */
program
    .command('accounts')
    .alias('ls')
    .description('列出所有已保存账号')
    .action(async () => {
    const accounts = await listAccounts();
    const current = await getCurrentAccount();
    if (accounts.length === 0) {
        log.info('暂无账号。使用 `sprr login <name>` 登录第一个账号');
        return;
    }
    if (globalJson) {
        console.log(JSON.stringify({ accounts, current }, null, 2));
        return;
    }
    log.info(`共 ${accounts.length} 个账号（* 标记当前账号）:`);
    for (const a of accounts) {
        const mark = a.name === current ? '*' : ' ';
        const time = new Date(a.savedAt).toLocaleString('zh-CN', { hour12: false });
        const sessionTag = a.hasSessionid ? '已登录' : '无sessionid';
        log.info(`  ${mark} ${a.name.padEnd(20)} uid=${(a.uid || '?').padEnd(20)} [${sessionTag}] 保存于 ${time}`);
    }
});
/* --------------------------- use 命令 --------------------------- */
program
    .command('use <name>')
    .description('切换当前账号')
    .action(async (name) => {
    try {
        await setCurrentAccount(name);
        log.info(`已切换到账号: ${name}`);
    }
    catch (e) {
        log.error('切换账号失败', e);
        process.exitCode = 1;
    }
});
/* --------------------------- logout 命令 --------------------------- */
program
    .command('logout <name>')
    .description('删除指定账号（本地 storageState，不影响抖音服务器登录态）')
    .option('-f, --force', '跳过确认提示', false)
    .action(async (name, opts) => {
    if (!opts.force) {
        log.warn(`将删除账号 ${name} 的本地登录态。如确认请加 -f 参数：sprr logout ${name} -f`);
        return;
    }
    try {
        await deleteAccount(name);
        log.info(`已删除账号: ${name}`);
    }
    catch (e) {
        log.error('删除账号失败', e);
        process.exitCode = 1;
    }
});
/* --------------------------- whoami 命令 --------------------------- */
program
    .command('whoami')
    .description('显示当前账号和登录态')
    .action(async () => {
    const current = await getCurrentAccount();
    if (!current) {
        log.info('当前未设置账号（将使用默认兜底 ../ccc/data/storageState.json）');
        log.info('使用 `sprr login <name>` 登录');
        return;
    }
    if (globalJson) {
        console.log(JSON.stringify({ current }, null, 2));
        return;
    }
    log.info(`当前账号: ${current}`);
    // 显示登录态摘要
    try {
        const { path: statePath } = await resolveStorageState(undefined, current);
        const session = await loadFromStorageState(statePath);
        const uid = session.uid || '?';
        const hasSid = Boolean(session.cookies['sessionid']);
        log.info(`  uid_tt: ${uid}`);
        log.info(`  sessionid: ${hasSid ? '有' : '无'}`);
        log.info(`  保存于: ${new Date(session.savedAt).toLocaleString('zh-CN', { hour12: false })}`);
    }
    catch (e) {
        log.warn(`  读取账号信息失败: ${e}`);
    }
});
/* ----------------------------- list 命令 ----------------------------- */
program
    .command('list')
    .description('列出所有会话（联系人）')
    .action(async () => {
    await run(async ({ env }) => {
        const contacts = await listContacts(env);
        const aliases = await loadAliases();
        // 自动获取 nickname：收集所有 sec_uid，批量调用 /aweme/v1/web/im/user/info/
        // 该接口仅需 Cookie，无需 a_bogus/msToken 签名（抓包验证）
        const secUidsToFetch = contacts
            .filter((c) => c.secUid && c.nickname === '(pending)')
            .map((c) => c.secUid);
        if (secUidsToFetch.length > 0) {
            log.info(`list: 批量获取 ${secUidsToFetch.length} 个用户的 nickname...`);
            const userInfoMap = await getUserInfoMap(env, secUidsToFetch);
            let resolvedCount = 0;
            for (const c of contacts) {
                if (!c.secUid)
                    continue;
                const info = userInfoMap.get(c.secUid);
                if (info && info.nickname) {
                    c.nickname = info.nickname;
                    resolvedCount++;
                }
                else if (c.nickname === '(pending)') {
                    // API 未返回该用户信息，fallback
                    c.nickname = `(uid:${c.uid.slice(-6)})`;
                }
            }
            log.info(`list: 成功获取 ${resolvedCount}/${secUidsToFetch.length} 个 nickname`);
        }
        // 应用本地备注（优先级高于 API 返回的 nickname）
        for (const c of contacts) {
            if (aliases[c.uid])
                c.nickname = aliases[c.uid];
        }
        const myUid = detectMyUid(contacts);
        output(contacts, (data) => {
            log.info(`共 ${data.length} 个会话`);
            if (myUid)
                log.info(`当前账号 UID: ${myUid}`);
            log.info('-'.repeat(80));
            log.info(formatTable(['#', '昵称', 'UID', '未读', '会话ID'], data.map((c, i) => [
                String(i + 1),
                c.nickname || '(未知)',
                c.uid || '-',
                c.unreadCount !== undefined ? String(c.unreadCount) : '-',
                c.conversationId,
            ])));
            log.info('-'.repeat(80));
            log.info(`提示: 使用 'sprr rename --uid <uid> --name <昵称>' 设置备注名`);
        });
    });
});
/* ----------------------------- rename 命令 ----------------------------- */
program
    .command('rename')
    .description('为指定用户设置本地备注名（便于通过昵称查找）')
    .requiredOption('--uid <uid>', '用户 UID')
    .requiredOption('--name <name>', '备注名')
    .action(async (opts) => {
    const aliases = await loadAliases();
    aliases[opts.uid] = opts.name;
    await saveAliases(aliases);
    log.info(`已设置: uid=${opts.uid} -> "${opts.name}"`);
    log.info(`备注文件: ${ALIAS_FILE}`);
});
/* ----------------------------- send 命令 ----------------------------- */
program
    .command('send')
    .description('向指定用户发送文本消息')
    .requiredOption('-t, --text <text>', '消息内容')
    .option('--to <target>', '目标用户 uid 或昵称（默认 "TwT"）', 'TwT')
    .action(async (opts) => {
    await run(async ({ env }) => {
        const contacts = await getContacts(env);
        const aliases = await loadAliases();
        for (const c of contacts) {
            if (aliases[c.uid])
                c.nickname = aliases[c.uid];
        }
        const myUid = detectMyUid(contacts);
        const target = await resolveTarget(env, opts.to, myUid, contacts);
        if (!target) {
            log.error(`找不到目标用户: ${opts.to}`);
            log.error(`提示: 使用 'sprr list' 查看所有会话和对应的 UID`);
            process.exitCode = 1;
            return;
        }
        log.info(`发送给: ${target.nickname} (uid=${target.uid})`);
        log.info(`消息内容: ${opts.text}`);
        const cid = buildPrivateCid(myUid, target.uid);
        const sign = {
            conversationShortId: target.conversationShortId,
            conversationType: 1,
            ticket: target.ticket || '',
        };
        const result = await sendMessage(env, cid, opts.text, sign);
        output(result, (data) => {
            if (data.success) {
                log.info(`发送成功`);
                if (data.serverMsgId)
                    log.info(`  serverMsgId: ${data.serverMsgId}`);
                if (data.msgId)
                    log.info(`  clientMsgId: ${data.msgId}`);
            }
            else {
                log.error(`发送失败: ${data.reason || '未知原因'}`);
                process.exitCode = 1;
            }
        });
    });
});
/* --------------------------- send-image 命令 --------------------------- */
program
    .command('send-image')
    .description('向指定用户发送图片消息')
    .requiredOption('-i, --image <path>', '图片文件路径')
    .option('--to <target>', '目标用户 uid 或昵称（默认 "TwT"）', 'TwT')
    .action(async (opts) => {
    await run(async ({ env }) => {
        // 读取图片文件
        let imageBytes;
        try {
            imageBytes = await fs.readFile(opts.image);
        }
        catch (e) {
            log.error(`读取图片失败: ${opts.image}`, e);
            process.exitCode = 1;
            return;
        }
        log.info(`图片: ${opts.image} (${imageBytes.length} 字节)`);
        const contacts = await getContacts(env);
        const aliases = await loadAliases();
        for (const c of contacts) {
            if (aliases[c.uid])
                c.nickname = aliases[c.uid];
        }
        const myUid = detectMyUid(contacts);
        const target = await resolveTarget(env, opts.to, myUid, contacts);
        if (!target) {
            log.error(`找不到目标用户: ${opts.to}`);
            log.error(`提示: 使用 'sprr list' 查看所有会话和对应的 UID`);
            process.exitCode = 1;
            return;
        }
        log.info(`发送给: ${target.nickname} (uid=${target.uid})`);
        // 1. 上传图片到 TOS（获取 oid/skey/md5）
        const commit = await uploadImage(env, imageBytes, myUid);
        if (!commit) {
            log.error(`上传图片失败，终止发送`);
            process.exitCode = 1;
            return;
        }
        // 2. 构造图片消息参数并发送
        const cid = buildPrivateCid(myUid, target.uid);
        const imageInfo = {
            oid: commit.encryptionUri,
            skey: commit.secretKey,
            md5: commit.sourceMd5,
            dataSize: commit.imgSize || imageBytes.length,
            width: commit.imgWidth,
            height: commit.imgHeight,
        };
        const sign = {
            conversationShortId: target.conversationShortId,
            conversationType: 1,
            ticket: target.ticket || '',
        };
        const result = await sendImage(env, cid, imageInfo, sign);
        output(result, (data) => {
            if (data.success) {
                log.info(`发送成功`);
                if (data.serverMsgId)
                    log.info(`  serverMsgId: ${data.serverMsgId}`);
                if (data.msgId)
                    log.info(`  clientMsgId: ${data.msgId}`);
            }
            else {
                log.error(`发送失败: ${data.reason || '未知原因'}`);
                process.exitCode = 1;
            }
        });
    });
});
/* ----------------------------- history 命令 ----------------------------- */
program
    .command('history')
    .description('获取指定会话的聊天记录')
    .option('--to <target>', '目标用户 uid 或昵称（默认 "TwT"）', 'TwT')
    .option('--cid <conversationId>', '直接指定 conversationId（优先于 --to）')
    .option('--limit <count>', '拉取条数（默认 30，可设为 500/1000 等拉取更多）', '30')
    .action(async (opts) => {
    await run(async ({ env }) => {
        const contacts = await getContacts(env);
        const aliases = await loadAliases();
        for (const c of contacts) {
            if (aliases[c.uid])
                c.nickname = aliases[c.uid];
        }
        const myUid = detectMyUid(contacts);
        let cid = opts.cid;
        let shortId;
        let nickname = '(指定会话)';
        if (!cid) {
            const target = await resolveTarget(env, opts.to, myUid, contacts);
            if (!target) {
                log.error(`找不到目标用户: ${opts.to}`);
                log.error(`提示: 使用 'sprr list' 查看所有会话和对应的 UID`);
                process.exitCode = 1;
                return;
            }
            cid = buildPrivateCid(myUid, target.uid);
            shortId = target.conversationShortId;
            nickname = target.nickname;
        }
        else {
            // 从 contacts 中查找对应 shortId
            const c = contacts.find((x) => x.conversationId === cid);
            if (c) {
                shortId = c.conversationShortId;
                nickname = c.nickname;
            }
            else {
                log.error(`未找到会话: ${cid}`);
                process.exitCode = 1;
                return;
            }
        }
        if (!shortId) {
            log.error(`无法获取 conversation_short_id（会话可能不存在）`);
            process.exitCode = 1;
            return;
        }
        const limit = parseInt(opts.limit, 10) || 30;
        log.info(`会话: ${nickname}  cid=${cid}  shortId=${shortId}  limit=${limit}`);
        let messages;
        if (limit > 50) {
            // 大量拉取，使用分页
            messages = await getHistoryAll(env, cid, {
                conversationShortId: shortId,
                myUid,
                pageSize: 50,
                maxMessages: limit,
            });
        }
        else {
            messages = await getHistory(env, cid, {
                conversationShortId: shortId,
                limit,
                myUid,
            });
        }
        // 图片解密（普通图片 + 加密图片）
        // 普通图片（msgType=27）：skey 在 content.resource_url.skey，URL 是密文
        // 加密图片（msgType=91）：需调 read_once/detail 拿 skey + URL，且只能查看一次
        // 加密机制：AES-256-GCM，key=skey(32B), nonce=密文前12B, tag=密文末16B
        const decodedDir = path.join(DATA_DIR, 'decoded');
        await fs.mkdir(decodedDir, { recursive: true });
        /** 下载密文 + AES-256-GCM 解密 + 保存到 data/decoded/ */
        async function downloadAndDecrypt(url, skey, oid) {
            try {
                const cipherRes = await fetch(url, {
                    headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.douyin.com/' },
                });
                if (!cipherRes.ok) {
                    log.warn(`  下载失败 HTTP ${cipherRes.status}`);
                    return false;
                }
                const ciphertext = Buffer.from(await cipherRes.arrayBuffer());
                const key = Buffer.from(skey, 'hex');
                const nonce = ciphertext.subarray(0, 12);
                const tag = ciphertext.subarray(ciphertext.length - 16);
                const data = ciphertext.subarray(12, ciphertext.length - 16);
                const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
                decipher.setAuthTag(tag);
                const plain = Buffer.concat([decipher.update(data), decipher.final()]);
                let ext = 'bin';
                if (plain.length >= 12) {
                    if (plain[0] === 0xff && plain[1] === 0xd8)
                        ext = 'jpg';
                    else if (plain[0] === 0x89 && plain[1] === 0x50)
                        ext = 'png';
                    else if (plain[0] === 0x52 && plain[8] === 0x57 && plain[9] === 0x45)
                        ext = 'webp';
                    else if (plain[0] === 0x47 && plain[1] === 0x49)
                        ext = 'gif';
                }
                const fileName = (oid || 'douyin_image').replace(/[~:/]/g, '_') + '.' + ext;
                const outPath = path.join(decodedDir, fileName);
                await fs.writeFile(outPath, plain);
                log.info(`  已保存: ${outPath} (${plain.length} 字节, ${ext.toUpperCase()})`);
                return true;
            }
            catch (e) {
                log.warn(`  解密下载失败: ${e}`);
                return false;
            }
        }
        // 1. 普通图片（msgType=27，skey 在消息 content 中）
        //    分两种：
        //    a) 有 large_url_list —— 直接用消息中的 URL
        //    b) 无 URL 但有 oid+skey（自己发的图片）—— 需调 batch_build_image 换 URL
        const plainImages = messages.filter((m) => m.category === 'image' && !m.isEncryptedImage && m.imageSkey);
        if (plainImages.length > 0) {
            const withUrl = plainImages.filter((m) => m.stickerUrl);
            const withoutUrl = plainImages.filter((m) => !m.stickerUrl);
            log.info(`检测到 ${plainImages.length} 条普通图片（有URL ${withUrl.length} / 无URL ${withoutUrl.length}），解密下载...`);
            let ok = 0;
            // a) 有 URL 的直接下载解密
            for (const m of withUrl) {
                const oid = m.contentJson?.match(/"oid"\s*:\s*"([^"]+)"/)?.[1] || 'douyin_image';
                if (await downloadAndDecrypt(m.stickerUrl, m.imageSkey, oid))
                    ok++;
            }
            // b) 无 URL 的先调 batch_build_image 换签名 URL
            for (const m of withoutUrl) {
                const oid = m.contentJson?.match(/"oid"\s*:\s*"([^"]+)"/)?.[1];
                if (!oid) {
                    log.warn('  无 oid，跳过');
                    continue;
                }
                const urls = await buildImageUrl(env, oid);
                if (urls.length === 0) {
                    log.warn(`  batch_build_image 失败 oid=${oid}`);
                    continue;
                }
                m.stickerUrl = urls[0];
                m.text = '[图片]';
                if (await downloadAndDecrypt(urls[0], m.imageSkey, oid))
                    ok++;
            }
            log.info(`普通图片解密完成: ${ok}/${plainImages.length} 成功，保存到 ${decodedDir}`);
        }
        // 2. 加密图片（msgType=91，需调 read_once/detail）
        const encryptedMsgs = messages.filter((m) => m.isEncryptedImage && m.serverMsgId);
        if (encryptedMsgs.length > 0) {
            log.info(`检测到 ${encryptedMsgs.length} 条加密图片，尝试解密（read_once/detail）...`);
            const shortIdStr = String(shortId);
            let decryptedCount = 0;
            let alreadyReadCount = 0;
            let savedCount = 0;
            for (const m of encryptedMsgs) {
                const info = await getReadOnceImage(env, m.serverMsgId, shortIdStr);
                if (info) {
                    m.stickerUrl = info.largeUrl;
                    m.text = '[加密图片:已解密]';
                    decryptedCount++;
                    if (info.skey && (await downloadAndDecrypt(info.largeUrl, info.skey, info.oid))) {
                        savedCount++;
                    }
                }
                else {
                    alreadyReadCount++;
                }
            }
            log.info(`加密图片解密完成: 成功 ${decryptedCount} | 已被查看过 ${alreadyReadCount} | 已保存 ${savedCount} 到 ${decodedDir}`);
        }
        output(messages, (data) => {
            log.info(`共 ${data.length} 条消息`);
            log.info('-'.repeat(80));
            for (const m of data) {
                log.info(formatMessageLine(m));
            }
            log.info('-'.repeat(80));
            // 统计
            const stats = {
                text: data.filter((m) => m.category === 'text').length,
                video_share: data.filter((m) => m.category === 'video_share').length,
                ai_text: data.filter((m) => m.category === 'ai_text').length,
                system_tip: data.filter((m) => m.category === 'system_tip').length,
                sticker: data.filter((m) => m.category === 'sticker').length,
                image: data.filter((m) => m.category === 'image').length,
                other: data.filter((m) => m.category === 'unknown').length,
            };
            log.info(`统计: 文本 ${stats.text} | 分享视频 ${stats.video_share} | AI回复 ${stats.ai_text} | 系统提示 ${stats.system_tip} | 表情 ${stats.sticker} | 图片 ${stats.image} | 其他 ${stats.other}`);
        });
    });
});
/* ----------------------------- 辅助函数 ----------------------------- */
/**
 * 加载 session 并执行回调
 *
 * 优先级：--state > --account > 当前账号指针 > 默认兜底
 */
async function run(fn) {
    let session;
    try {
        const { path: statePath, source } = await resolveStorageState(globalState, globalAccount);
        log.debug(`使用 storageState: ${statePath}（来源: ${source}）`);
        session = await loadFromStorageState(statePath);
    }
    catch (e) {
        log.error('加载 session 失败', e);
        if (globalState || globalAccount) {
            // 用户显式指定但失败，不再回退
            process.exitCode = 1;
            return;
        }
        // 无账号且兜底文件不存在，提示登录
        log.error('未找到可用账号。请先运行: sprr login <name>');
        process.exitCode = 1;
        return;
    }
    const env = envFromSession(session);
    try {
        await fn({ env, session });
    }
    catch (e) {
        log.error('执行失败', e);
        process.exitCode = 1;
    }
}
/** 已加载的联系人缓存（避免每次 resolveTarget 都重新拉取） */
let _contactsCache = null;
async function getContacts(env) {
    if (!_contactsCache) {
        _contactsCache = await listContacts(env);
        // 自动获取 nickname（与 list 命令一致）
        const secUidsToFetch = _contactsCache
            .filter((c) => c.secUid && c.nickname === '(pending)')
            .map((c) => c.secUid);
        if (secUidsToFetch.length > 0) {
            log.info(`getContacts: 批量获取 ${secUidsToFetch.length} 个用户的 nickname...`);
            const userInfoMap = await getUserInfoMap(env, secUidsToFetch);
            for (const c of _contactsCache) {
                if (!c.secUid)
                    continue;
                const info = userInfoMap.get(c.secUid);
                if (info && info.nickname) {
                    c.nickname = info.nickname;
                }
                else if (c.nickname === '(pending)') {
                    c.nickname = `(uid:${c.uid.slice(-6)})`;
                }
            }
        }
    }
    return _contactsCache;
}
/**
 * 解析目标用户：支持直接传 uid、cid，或通过昵称在会话列表中查找
 */
async function resolveTarget(env, target, myUid, contacts) {
    // 1. 数字串视为 uid
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
        // uid 不在会话列表中，无法获取 shortId（send 需要）
        log.error(`uid ${target} 不在会话列表中，无法获取 conversation_short_id`);
        return null;
    }
    // 2. 按 conversation_id 查找
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
    // 3. 按昵称精确匹配
    let match = contacts.find((c) => c.nickname === target || c.remark === target);
    // 4. 模糊匹配
    if (!match) {
        match = contacts.find((c) => c.nickname.includes(target) || (c.remark?.includes(target) ?? false));
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
/**
 * 格式化单条消息为一行显示
 *
 * 格式: [时间] [消息类型标签] 发送者: 内容
 *   消息类型标签：[文本] [分享视频] [AI回复] [系统提示] [图片] [表情] [未知]
 *   发送者：我 / 对方 / 小火人 / 系统
 */
function formatMessageLine(m) {
    const ts = m.timestamp
        ? new Date(m.timestamp).toLocaleString('zh-CN', { hour12: false })
        : '                   ';
    const typeTag = formatCategoryTag(m.category);
    const sender = m.senderLabel.padEnd(3, ' ');
    let content;
    if (m.category === 'video_share') {
        // 视频分享：显示作者 + 标题
        const author = m.videoAuthor ? `作者:${m.videoAuthor} ` : '';
        content = `${author}${m.text || '(无标题)'}`;
    }
    else if (m.category === 'system_tip') {
        content = m.text || '(系统提示)';
    }
    else if (m.category === 'image') {
        // 图片：显示 [图片] + URL（如果有）
        content = m.stickerUrl ? `${m.text || '[图片]'} ${m.stickerUrl}` : (m.text || '[图片]');
    }
    else if (m.category === 'sticker') {
        // 表情贴纸：显示描述 + 图片 URL（便于查看原图）
        content = m.stickerUrl ? `${m.text} ${m.stickerUrl}` : (m.text || '[表情]');
    }
    else {
        content = m.text || '(空消息)';
    }
    return `  [${ts}] ${typeTag} ${sender}: ${content}`;
}
/** 消息类别标签（固定宽度，便于对齐） */
function formatCategoryTag(category) {
    switch (category) {
        case 'text': return '[文本]    ';
        case 'video_share': return '[分享视频]';
        case 'ai_text': return '[AI回复]  ';
        case 'system_tip': return '[系统提示]';
        case 'image': return '[图片]    ';
        case 'sticker': return '[表情]    ';
        default: return '[未知]    ';
    }
}
/**
 * 简单的 ASCII 表格格式化
 */
function formatTable(headers, rows) {
    const widths = headers.map((h, i) => {
        const maxRowLen = Math.max(...rows.map((r) => (r[i] || '').length));
        return Math.max(h.length, maxRowLen);
    });
    const pad = (s, i) => (s || '').padEnd(widths[i]);
    const sep = '-'.repeat(widths.reduce((a, b) => a + b + 3, 0));
    const headerLine = headers.map(pad).join(' | ');
    const rowLines = rows.map((r) => r.map(pad).join(' | '));
    return [headerLine, sep, ...rowLines].join('\n');
}
/**
 * 输出结果：JSON 模式直接打印 JSON，否则走回调
 */
function output(data, pretty) {
    if (globalJson) {
        process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    }
    else {
        pretty(data);
    }
}
program.parseAsync(process.argv).catch((e) => {
    log.error('命令执行异常', e);
    process.exitCode = 1;
});
