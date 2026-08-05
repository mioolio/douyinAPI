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
import { DEFAULT_STORAGE_STATE, DATA_DIR } from './config/paths.js';
import { loadFromStorageState, sessionFromCookieString, type SessionData } from './auth/session.js';
import {
  resolveStorageState,
  listAccounts,
  getCurrentAccount,
  setCurrentAccount,
  deleteAccount,
  validateAccountName,
} from './auth/accounts.js';
import {
  envFromSession,
  listContacts,
  sendMessage,
  sendImage,
  sendSticker,
  sendQuoteReply,
  recallMessage,
  getHistoryAll,
  getHistory,
  buildPrivateCid,
  detectMyUid,
  type ContactItem,
  type MessageItem,
  type SendSignContext,
  type ImageSendInfo,
  type StickerSendInfo,
  type QuoteReplyRef,
} from './api/operations.js';
import {
  getUserInfoMap,
  getReadOnceImage,
  buildImageUrl,
  collectSticker,
  getVideoDetail,
  getAwemeDetail,
  getCommentList,
  publishComment,
  type VideoDetailInfo,
  type AwemeDetailInfo,
  type CommentInfo,
  type TicketGuardHeaders,
} from './api/webapi.js';
import {
  loadTicketGuard,
  saveTicketGuard,
  extractTicketGuardFromCapture,
  loadOrExtractTicketGuard,
  isTicketGuardExpired,
  type TicketGuardConfig,
} from './crypto/ticket-guard.js';
import { uploadImage } from './api/tos.js';
import { connectFrontier, type FrontierFrame } from './api/frontier.js';
import { extractWsAccessKey, watchFrontierViaBrowser } from './commands/extract-ws-key.js';
import { autoExtractTicketGuard } from './commands/ticket-guard-auto.js';

const log = createLogger('cli');

/** 本地备注映射文件路径（uid -> nickname） */
const ALIAS_FILE = path.join(DATA_DIR, 'aliases.json');

/** 读取本地备注映射 */
async function loadAliases(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(ALIAS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** 保存本地备注映射 */
async function saveAliases(aliases: Record<string, string>): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(ALIAS_FILE, JSON.stringify(aliases, null, 2), 'utf-8');
}

let globalVerbose = false;
let globalJson = false;
let globalState: string | undefined;
let globalAccount: string | undefined;
let globalCookie: string | undefined;

const program = new Command();

program
  .name('sprr')
  .description('抖音私信聊天自动化工具（纯 API 逆向版）')
  .version('0.0.1')
  .option('--verbose', '输出详细日志（debug 级别）', false)
  .option('--json', '以 JSON 格式输出结果', false)
  .option('--state <path>', 'storageState 文件路径（优先级最高）', undefined)
  .option('--account <name>', '临时使用指定账号（不修改当前账号指针）', undefined)
  .option('--cookie <string>', '直接使用 cookie 字符串（优先级最高，无需登录）', undefined)
  .hook('preAction', (cmd) => {
    const opts = program.opts();
    globalVerbose = Boolean(opts.verbose);
    globalJson = Boolean(opts.json);
    globalState = opts.state;
    globalAccount = opts.account;
    globalCookie = opts.cookie;
    if (globalVerbose) {
      process.env.SPRR_DEBUG = '1';
    }
  });

/* --------------------------- login 命令 --------------------------- */

program
  .command('login <name>')
  .description('启动浏览器扫码登录抖音，保存为指定账号（自动设为当前账号）')
  .option('--timeout <ms>', '登录超时毫秒数（默认 300000 = 5 分钟）', '300000')
  .action(async (name: string, opts: { timeout: string }) => {
    validateAccountName(name);
    const timeout = parseInt(opts.timeout, 10);
    // 动态导入 playwright，避免未安装时其他命令也加载失败
    let loginFn: typeof import('./commands/login.js').loginAccount;
    try {
      const mod = await import('./commands/login.js');
      loginFn = mod.loginAccount;
    } catch (e) {
      log.error('加载登录模块失败（确保已安装 playwright: pnpm add -D playwright）', e);
      process.exitCode = 1;
      return;
    }
    try {
      await loginFn(name, { timeout });
    } catch (e) {
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
      log.info(
        `  ${mark} ${a.name.padEnd(20)} uid=${(a.uid || '?').padEnd(20)} [${sessionTag}] 保存于 ${time}`,
      );
    }
  });

/* --------------------------- use 命令 --------------------------- */

program
  .command('use <name>')
  .description('切换当前账号')
  .action(async (name: string) => {
    try {
      await setCurrentAccount(name);
      log.info(`已切换到账号: ${name}`);
    } catch (e) {
      log.error('切换账号失败', e);
      process.exitCode = 1;
    }
  });

/* --------------------------- logout 命令 --------------------------- */

program
  .command('logout <name>')
  .description('删除指定账号（本地 storageState，不影响抖音服务器登录态）')
  .option('-f, --force', '跳过确认提示', false)
  .action(async (name: string, opts: { force: boolean }) => {
    if (!opts.force) {
      log.warn(`将删除账号 ${name} 的本地登录态。如确认请加 -f 参数：sprr logout ${name} -f`);
      return;
    }
    try {
      await deleteAccount(name);
      log.info(`已删除账号: ${name}`);
    } catch (e) {
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
    } catch (e) {
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
        .map((c) => c.secUid!) as string[];
      if (secUidsToFetch.length > 0) {
        log.info(`list: 批量获取 ${secUidsToFetch.length} 个用户的 nickname...`);
        const userInfoMap = await getUserInfoMap(env, secUidsToFetch);
        let resolvedCount = 0;
        for (const c of contacts) {
          if (!c.secUid) continue;
          const info = userInfoMap.get(c.secUid);
          if (info && info.nickname) {
            c.nickname = info.nickname;
            resolvedCount++;
          } else if (c.nickname === '(pending)') {
            // API 未返回该用户信息，fallback
            c.nickname = `(uid:${c.uid.slice(-6)})`;
          }
        }
        log.info(`list: 成功获取 ${resolvedCount}/${secUidsToFetch.length} 个 nickname`);
      }

      // 应用本地备注（优先级高于 API 返回的 nickname）
      for (const c of contacts) {
        if (aliases[c.uid]) c.nickname = aliases[c.uid];
      }
      const myUid = detectMyUid(contacts);
      output(contacts, (data) => {
        log.info(`共 ${data.length} 个会话`);
        if (myUid) log.info(`当前账号 UID: ${myUid}`);
        log.info('-'.repeat(80));
        log.info(formatTable(
          ['#', '昵称', 'UID', '未读', '会话ID'],
          data.map((c, i) => [
            String(i + 1),
            c.nickname || '(未知)',
            c.uid || '-',
            c.unreadCount !== undefined ? String(c.unreadCount) : '-',
            c.conversationId,
          ]),
        ));
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
  .action(async (opts: { uid: string; name: string }) => {
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
  .action(async (opts: { text: string; to: string }) => {
    await run(async ({ env }) => {
      const contacts = await getContacts(env);
      const aliases = await loadAliases();
      for (const c of contacts) {
        if (aliases[c.uid]) c.nickname = aliases[c.uid];
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
      const sign: SendSignContext = {
        conversationShortId: target.conversationShortId,
        conversationType: 1,
        ticket: target.ticket || '',
      };
      const result = await sendMessage(env, cid, opts.text, sign);
      output(result, (data) => {
        if (data.success) {
          log.info(`发送成功`);
          if (data.serverMsgId) log.info(`  serverMsgId: ${data.serverMsgId}`);
          if (data.msgId) log.info(`  clientMsgId: ${data.msgId}`);
        } else {
          log.error(`发送失败: ${data.reason || '未知原因'}`);
          process.exitCode = 1;
        }
      });
    });
  });

/* ----------------------------- recall 命令 ----------------------------- */

program
  .command('recall')
  .description('撤回指定消息（默认撤回最近一条自己发送的消息）')
  .option('--to <target>', '目标用户 uid 或昵称（默认 "TwT"）', 'TwT')
  .option('--cid <conversationId>', '直接指定 conversationId（优先于 --to）')
  .option('--msg-id <serverMsgId>', '指定要撤回的 server_message_id（不指定则自动取最近一条自己发的消息）')
  .action(async (opts: { to: string; cid?: string; msgId?: string }) => {
    await run(async ({ env }) => {
      const contacts = await getContacts(env);
      const aliases = await loadAliases();
      for (const c of contacts) {
        if (aliases[c.uid]) c.nickname = aliases[c.uid];
      }
      const myUid = detectMyUid(contacts);

      // 解析 conversationId 和 conversationShortId
      let conversationId: string;
      let conversationShortId: string;
      let targetLabel: string;

      if (opts.cid) {
        // 直接指定 cid
        const c = contacts.find((x) => x.conversationId === opts.cid);
        if (!c || !c.conversationShortId) {
          log.error(`找不到会话: ${opts.cid}`);
          process.exitCode = 1;
          return;
        }
        conversationId = opts.cid;
        conversationShortId = c.conversationShortId;
        targetLabel = c.nickname || c.uid;
      } else {
        const target = await resolveTarget(env, opts.to, myUid, contacts);
        if (!target) {
          log.error(`找不到目标用户: ${opts.to}`);
          log.error(`提示: 使用 'sprr list' 查看所有会话和对应的 UID`);
          process.exitCode = 1;
          return;
        }
        conversationId = buildPrivateCid(myUid, target.uid);
        conversationShortId = target.conversationShortId;
        targetLabel = target.nickname;
      }

      log.info(`目标会话: ${targetLabel} cid=${conversationId} shortId=${conversationShortId}`);

      let serverMsgId = opts.msgId;
      if (!serverMsgId) {
        // 自动取最近一条自己发的消息
        log.info(`未指定 --msg-id，拉取最近消息查找自己发送的消息...`);
        const messages = await getHistory(env, conversationId, {
          direction: 3, // FROM_LATEST
          limit: 20,
          conversationShortId,
          myUid,
        });
        const myMsg = messages.find((m) => m.isSelf);
        if (!myMsg || !myMsg.serverMsgId) {
          log.error(`未找到自己发送的消息（最近 ${messages.length} 条内）`);
          process.exitCode = 1;
          return;
        }
        serverMsgId = myMsg.serverMsgId;
        log.info(`找到最近一条自己发的消息: serverMsgId=${serverMsgId} text=${JSON.stringify(myMsg.text?.slice(0, 30))}`);
      }

      const result = await recallMessage(env, conversationId, serverMsgId, conversationShortId);
      output(result, (data) => {
        if (data.success) {
          log.info(`撤回成功`);
          if (data.serverMsgId) log.info(`  serverMsgId: ${data.serverMsgId}`);
        } else {
          log.error(`撤回失败: ${data.reason || '未知原因'}`);
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
  .action(async (opts: { image: string; to: string }) => {
    await run(async ({ env }) => {
      // 读取图片文件
      let imageBytes: Buffer;
      try {
        imageBytes = await fs.readFile(opts.image);
      } catch (e) {
        log.error(`读取图片失败: ${opts.image}`, e);
        process.exitCode = 1;
        return;
      }
      log.info(`图片: ${opts.image} (${imageBytes.length} 字节)`);

      const contacts = await getContacts(env);
      const aliases = await loadAliases();
      for (const c of contacts) {
        if (aliases[c.uid]) c.nickname = aliases[c.uid];
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
        conversationType: 1,
        ticket: target.ticket || '',
      };
      const result = await sendImage(env, cid, imageInfo, sign);
      output(result, (data) => {
        if (data.success) {
          log.info(`发送成功`);
          if (data.serverMsgId) log.info(`  serverMsgId: ${data.serverMsgId}`);
          if (data.msgId) log.info(`  clientMsgId: ${data.msgId}`);
        } else {
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
  .action(async (opts: { to: string; cid?: string; limit: string }) => {
    await run(async ({ env }) => {
      const contacts = await getContacts(env);
      const aliases = await loadAliases();
      for (const c of contacts) {
        if (aliases[c.uid]) c.nickname = aliases[c.uid];
      }
      const myUid = detectMyUid(contacts);
      let cid = opts.cid;
      let shortId: string | undefined;
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
      } else {
        // 从 contacts 中查找对应 shortId
        const c = contacts.find((x) => x.conversationId === cid);
        if (c) {
          shortId = c.conversationShortId;
          nickname = c.nickname;
        } else {
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

      let messages: MessageItem[];
      if (limit > 50) {
        // 大量拉取，使用分页
        messages = await getHistoryAll(env, cid, {
          conversationShortId: shortId,
          myUid,
          pageSize: 50,
          maxMessages: limit,
        });
      } else {
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
      async function downloadAndDecrypt(url: string, skey: string, oid: string): Promise<boolean> {
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
            if (plain[0] === 0xff && plain[1] === 0xd8) ext = 'jpg';
            else if (plain[0] === 0x89 && plain[1] === 0x50) ext = 'png';
            else if (plain[0] === 0x52 && plain[8] === 0x57 && plain[9] === 0x45) ext = 'webp';
            else if (plain[0] === 0x47 && plain[1] === 0x49) ext = 'gif';
          }
          const fileName = (oid || 'douyin_image').replace(/[~:/]/g, '_') + '.' + ext;
          const outPath = path.join(decodedDir, fileName);
          await fs.writeFile(outPath, plain);
          log.info(`  已保存: ${outPath} (${plain.length} 字节, ${ext.toUpperCase()})`);
          return true;
        } catch (e) {
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
          if (await downloadAndDecrypt(m.stickerUrl!, m.imageSkey!, oid)) ok++;
        }
        // b) 无 URL 的先调 batch_build_image 换签名 URL
        for (const m of withoutUrl) {
          const oid = m.contentJson?.match(/"oid"\s*:\s*"([^"]+)"/)?.[1];
          if (!oid) { log.warn('  无 oid，跳过'); continue; }
          const urls = await buildImageUrl(env, oid);
          if (urls.length === 0) { log.warn(`  batch_build_image 失败 oid=${oid}`); continue; }
          m.stickerUrl = urls[0];
          m.text = '[图片]';
          if (await downloadAndDecrypt(urls[0], m.imageSkey!, oid)) ok++;
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
          const info = await getReadOnceImage(env, m.serverMsgId!, shortIdStr);
          if (info) {
            m.stickerUrl = info.largeUrl;
            m.text = '[加密图片:已解密]';
            decryptedCount++;
            if (info.skey && (await downloadAndDecrypt(info.largeUrl, info.skey, info.oid))) {
              savedCount++;
            }
          } else {
            alreadyReadCount++;
          }
        }
        log.info(
          `加密图片解密完成: 成功 ${decryptedCount} | 已被查看过 ${alreadyReadCount} | 已保存 ${savedCount} 到 ${decodedDir}`,
        );
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
          recall: data.filter((m) => m.category === 'recall').length,
          other: data.filter((m) => m.category === 'unknown').length,
        };
        log.info(
          `统计: 文本 ${stats.text} | 分享视频 ${stats.video_share} | AI回复 ${stats.ai_text} | 系统提示 ${stats.system_tip} | 表情 ${stats.sticker} | 图片 ${stats.image} | 撤回 ${stats.recall} | 其他 ${stats.other}`,
        );
      });
    });
  });

/* --------------------------- send-sticker 命令 --------------------------- */

program
  .command('send-sticker')
  .description('发送表情贴纸消息（两种模式：--from-msg 从历史消息提取 / --sticker 从 JSON 文件读取）')
  .option('-s, --sticker <path>', 'sticker 信息 JSON 文件路径')
  .option('-m, --from-msg <serverMsgId>', '从历史 sticker 消息中提取信息（转发对方发来的表情）')
  .option('--to <target>', '目标用户 uid 或昵称（默认 "TwT"）', 'TwT')
  .action(async (opts: { sticker?: string; fromMsg?: string; to: string }) => {
    if (!opts.sticker && !opts.fromMsg) {
      log.error(`必须指定 --sticker <path> 或 --from-msg <serverMsgId>`);
      process.exitCode = 1;
      return;
    }
    await run(async ({ env }) => {
      const contacts = await getContacts(env);
      const aliases = await loadAliases();
      for (const c of contacts) {
        if (aliases[c.uid]) c.nickname = aliases[c.uid];
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

      let stickerInfo: StickerSendInfo;

      if (opts.fromMsg) {
        // 模式 A：从历史 sticker 消息提取信息（转发对方发来的表情）
        const cid = buildPrivateCid(myUid, target.uid);
        log.info(`查找 sticker 消息: serverMsgId=${opts.fromMsg}`);
        const messages = await getHistory(env, cid, {
          direction: 3,
          limit: 50,
          conversationShortId: target.conversationShortId,
          myUid,
        });
        const stickerMsg = messages.find((m) => m.serverMsgId === opts.fromMsg);
        if (!stickerMsg || stickerMsg.category !== 'sticker') {
          log.error(`未找到 sticker 消息（serverMsgId=${opts.fromMsg}）`);
          process.exitCode = 1;
          return;
        }
        const content = JSON.parse(stickerMsg.contentJson || '{}');
        const urlObj = content.url || {};
        stickerInfo = {
          imageId: content.image_id,
          packageId: content.package_id ?? 0,
          width: Number(content.width ?? urlObj.width ?? 300),
          height: Number(content.height ?? urlObj.height ?? 300),
          imageType: content.image_type ?? 'webp',
          uri: urlObj.uri ?? '',
          urlList: urlObj.url_list ?? [],
          displayName: content.display_name ?? '',
        };
        log.info(
          `从历史消息提取: imageId=${stickerInfo.imageId} packageId=${stickerInfo.packageId} ${stickerInfo.width}x${stickerInfo.height}`,
        );
      } else {
        // 模式 B：从 JSON 文件读取（支持 camelCase 和 snake_case 两种字段命名）
        try {
          const raw = await fs.readFile(opts.sticker!, 'utf-8');
          const obj = JSON.parse(raw);
          const urlObj = obj.url || {};
          stickerInfo = {
            imageId: obj.imageId ?? obj.image_id,
            packageId: obj.packageId ?? obj.package_id ?? 0,
            width: Number(obj.width ?? urlObj.width ?? 300),
            height: Number(obj.height ?? urlObj.height ?? 300),
            imageType: obj.imageType ?? obj.image_type ?? 'webp',
            uri: obj.uri ?? urlObj.uri ?? '',
            urlList: obj.urlList ?? urlObj.url_list ?? [],
            displayName: obj.displayName ?? obj.display_name ?? '',
          };
        } catch (e) {
          log.error(`读取 sticker 文件失败: ${opts.sticker}`, e);
          process.exitCode = 1;
          return;
        }
        log.info(
          `从文件读取: imageId=${stickerInfo.imageId} packageId=${stickerInfo.packageId} ${stickerInfo.width}x${stickerInfo.height}`,
        );
      }

      if (!stickerInfo.imageId || !stickerInfo.uri || stickerInfo.urlList.length === 0) {
        log.error(
          `sticker 信息不完整，需包含 imageId/image_id、uri（或 url.uri）、urlList（或 url.url_list）`,
        );
        process.exitCode = 1;
        return;
      }

      const cid = buildPrivateCid(myUid, target.uid);
      const sign: SendSignContext = {
        conversationShortId: target.conversationShortId,
        conversationType: 1,
        ticket: target.ticket || '',
      };
      const result = await sendSticker(env, cid, stickerInfo, sign);
      output(result, (data) => {
        if (data.success) {
          log.info(`发送成功`);
          if (data.serverMsgId) log.info(`  serverMsgId: ${data.serverMsgId}`);
        } else {
          log.error(`发送失败: ${data.reason || '未知原因'}`);
          process.exitCode = 1;
        }
      });
    });
  });

/* ----------------------------- reply 命令 ----------------------------- */

program
  .command('reply')
  .description('引用回复消息（quote-reply）')
  .requiredOption('-t, --text <text>', '回复内容')
  .requiredOption('-r, --ref <serverMsgId>', '被引用消息的 server_message_id')
  .option('--to <target>', '目标用户 uid 或昵称（默认 "TwT"）', 'TwT')
  .action(async (opts: { text: string; ref: string; to: string }) => {
    await run(async ({ env }) => {
      const contacts = await getContacts(env);
      const aliases = await loadAliases();
      for (const c of contacts) {
        if (aliases[c.uid]) c.nickname = aliases[c.uid];
      }
      const myUid = detectMyUid(contacts);
      const target = await resolveTarget(env, opts.to, myUid, contacts);
      if (!target) {
        log.error(`找不到目标用户: ${opts.to}`);
        log.error(`提示: 使用 'sprr list' 查看所有会话和对应的 UID`);
        process.exitCode = 1;
        return;
      }
      const cid = buildPrivateCid(myUid, target.uid);
      const shortId = target.conversationShortId;

      // 从历史消息中找到被引用的消息
      log.info(`查找被引用消息: serverMsgId=${opts.ref}`);
      const messages = await getHistory(env, cid, {
        direction: 3,
        limit: 50,
        conversationShortId: shortId,
        myUid,
      });
      const refMsg = messages.find((m) => m.serverMsgId === opts.ref);
      if (!refMsg) {
        log.error(`未找到 serverMsgId=${opts.ref} 的消息（最近 ${messages.length} 条内）`);
        process.exitCode = 1;
        return;
      }
      log.info(`被引用消息: [${refMsg.category}] ${refMsg.text?.slice(0, 30)}`);

      // 构造 QuoteReplyRef
      const ref: QuoteReplyRef = {
        serverMsgId: refMsg.serverMsgId!,
        refmsgType: refMsg.messageType,
        refmsgUid: refMsg.senderId,
        refmsgSecUid: '',
        refmsgNickname: refMsg.senderLabel === '我' ? '我' : '对方',
        refmsgShortText: refMsg.text || '',
        refmsgContent: refMsg.contentJson || '{}',
      };

      const sign: SendSignContext = {
        conversationShortId: shortId,
        conversationType: 1,
        ticket: target.ticket || '',
      };
      const result = await sendQuoteReply(env, cid, opts.text, ref, sign);
      output(result, (data) => {
        if (data.success) {
          log.info(`回复成功`);
          if (data.serverMsgId) log.info(`  serverMsgId: ${data.serverMsgId}`);
        } else {
          log.error(`回复失败: ${data.reason || '未知原因'}`);
          process.exitCode = 1;
        }
      });
    });
  });

/* --------------------------- collect-sticker 命令 --------------------------- */

program
  .command('collect-sticker')
  .description('收藏表情贴纸（从历史消息中找到 sticker 并收藏）')
  .requiredOption('-m, --msg-id <serverMsgId>', 'sticker 消息的 server_message_id')
  .option('--to <target>', '目标用户 uid 或昵称（默认 "TwT"）', 'TwT')
  .option('--action <n>', '1=收藏（默认）, 0=取消收藏', '1')
  .action(async (opts: { msgId: string; to: string; action: string }) => {
    await run(async ({ env }) => {
      const contacts = await getContacts(env);
      const aliases = await loadAliases();
      for (const c of contacts) {
        if (aliases[c.uid]) c.nickname = aliases[c.uid];
      }
      const myUid = detectMyUid(contacts);
      const target = await resolveTarget(env, opts.to, myUid, contacts);
      if (!target) {
        log.error(`找不到目标用户: ${opts.to}`);
        log.error(`提示: 使用 'sprr list' 查看所有会话和对应的 UID`);
        process.exitCode = 1;
        return;
      }
      const cid = buildPrivateCid(myUid, target.uid);
      const shortId = target.conversationShortId;

      // 从历史消息中找到 sticker 消息
      log.info(`查找 sticker 消息: serverMsgId=${opts.msgId}`);
      const messages = await getHistory(env, cid, {
        direction: 3,
        limit: 50,
        conversationShortId: shortId,
        myUid,
      });
      const stickerMsg = messages.find((m) => m.serverMsgId === opts.msgId);
      if (!stickerMsg || stickerMsg.category !== 'sticker') {
        log.error(`未找到 sticker 消息（serverMsgId=${opts.msgId}）`);
        process.exitCode = 1;
        return;
      }

      // 从 content JSON 中提取 sticker 元数据
      const content = JSON.parse(stickerMsg.contentJson || '{}');
      const stickerId = String(content.image_id);
      const stickerUri = content.url?.uri || '';
      const stickerUrl = content.url?.url_list?.[0] || stickerMsg.stickerUrl || '';
      const resourceId = String(content.package_id);
      const stickerType = content.resource_type ?? 1;

      if (!stickerId || !stickerUri || !stickerUrl || !resourceId) {
        log.error(
          `sticker 元数据不完整: image_id=${stickerId} uri=${stickerUri} resourceId=${resourceId}`,
        );
        process.exitCode = 1;
        return;
      }

      log.info(`sticker: id=${stickerId} uri=${stickerUri} resourceId=${resourceId}`);

      const action = parseInt(opts.action, 10) || 1;
      // collectSticker 内部基于 cookie 自动生成 a_bogus + msToken 签名
      const ok = await collectSticker(
        env,
        {
          stickerId,
          stickerUri,
          stickerUrl,
          resourceId,
          stickerType,
        },
        action,
      );
      if (ok) {
        log.info(`操作成功（action=${action}）`);
      } else {
        log.error(`操作失败`);
        process.exitCode = 1;
      }
    });
  });

/* ----------------------------- video 命令 ----------------------------- */

program
  .command('video')
  .description('查看视频分享详情（从历史消息或直接 aweme_id）')
  .option('--to <target>', '目标用户 uid 或昵称（默认 "TwT"）', 'TwT')
  .option('--aweme-id <id>', '视频 aweme_id（直接指定，优先于 --msg-id）')
  .option('--msg-id <serverMsgId>', '从历史视频分享消息中提取 aweme_id')
  .action(async (opts: { to: string; awemeId?: string; msgId?: string }) => {
    await run(async ({ env }) => {
      const contacts = await getContacts(env);
      const aliases = await loadAliases();
      for (const c of contacts) {
        if (aliases[c.uid]) c.nickname = aliases[c.uid];
      }
      const myUid = detectMyUid(contacts);
      const target = await resolveTarget(env, opts.to, myUid, contacts);
      if (!target) {
        log.error(`找不到目标用户: ${opts.to}`);
        log.error(`提示: 使用 'sprr list' 查看所有会话和对应的 UID`);
        process.exitCode = 1;
        return;
      }
      const shortId = target.conversationShortId;

      let awemeIds: string[] = [];
      if (opts.awemeId) {
        awemeIds = [opts.awemeId];
      } else if (opts.msgId) {
        const cid = buildPrivateCid(myUid, target.uid);
        log.info(`查找视频分享消息: serverMsgId=${opts.msgId}`);
        const messages = await getHistory(env, cid, {
          direction: 3,
          limit: 50,
          conversationShortId: shortId,
          myUid,
        });
        const videoMsg = messages.find((m) => m.serverMsgId === opts.msgId);
        if (!videoMsg || videoMsg.category !== 'video_share') {
          log.error(`未找到视频分享消息（serverMsgId=${opts.msgId}）`);
          process.exitCode = 1;
          return;
        }
        const content = JSON.parse(videoMsg.contentJson || '{}');
        // 视频分享消息中 aweme_id 存于 itemId 字段（驼峰），非 item_id/aweme_id
        const id = String(content.itemId || content.aweme_id || content.item_id || '');
        if (!id) {
          log.error(`消息中未找到 aweme_id`);
          process.exitCode = 1;
          return;
        }
        awemeIds = [id];
      } else {
        log.error(`必须指定 --aweme-id 或 --msg-id`);
        process.exitCode = 1;
        return;
      }

      log.info(`查询视频详情: awemeIds=${awemeIds.join(',')}`);
      // getVideoDetail 内部基于 cookie 自动生成 a_bogus + msToken 签名
      const videos = await getVideoDetail(env, awemeIds, shortId);
      if (videos.length === 0) {
        log.error(`查询失败`);
        process.exitCode = 1;
        return;
      }
      output(videos, (data) => {
        for (const v of data) {
          log.info('-'.repeat(80));
          log.info(`视频 ID: ${v.awemeId}`);
          if (v.desc) log.info(`标题: ${v.desc}`);
          if (v.authorNickname) log.info(`作者: ${v.authorNickname}`);
          if (v.duration) log.info(`时长: ${v.duration}ms`);
          if (v.diggCount !== undefined) log.info(`点赞: ${v.diggCount}`);
          if (v.commentCount !== undefined) log.info(`评论: ${v.commentCount}`);
          if (v.shareCount !== undefined) log.info(`分享: ${v.shareCount}`);
          if (v.coverUrl) log.info(`封面: ${v.coverUrl}`);
          if (v.playUrl) log.info(`播放: ${v.playUrl}`);
        }
        log.info('-'.repeat(80));
      });
    });
  });

/* ----------------------------- watch 命令 ----------------------------- */

program
  .command('watch')
  .description('实时监控新消息推送（纯 Node.js WebSocket，抖音通过 frontier-im.douyin.com 推送）')
  .option('--access-key <key>', '手动指定 access_key（不指定则自动从浏览器提取后关闭）')
  .option('--device-id <uid>', '设备ID（即用户UID，默认自动检测）')
  .option('--to <target>', '仅监控指定会话（uid 或昵称，默认监控所有会话）')
  .option('--raw', '显示原始帧（不解析消息内容，便于调试）', false)
  .action(async (opts: { accessKey?: string; deviceId?: string; to?: string; raw: boolean }) => {
    await run(async ({ env, session }) => {
      const contacts = await getContacts(env);
      const aliases = await loadAliases();
      for (const c of contacts) {
        if (aliases[c.uid]) c.nickname = aliases[c.uid];
      }
      const myUid = detectMyUid(contacts);
      if (!myUid) {
        log.error('无法识别当前账号 UID');
        process.exitCode = 1;
        return;
      }
      log.info(`当前账号 UID: ${myUid}`);

      // 解析目标会话（如果指定了 --to）
      let targetCid: string | undefined;
      if (opts.to) {
        const target = await resolveTarget(env, opts.to, myUid, contacts);
        if (!target) {
          log.error(`找不到目标用户: ${opts.to}`);
          log.error(`提示: 使用 'sprr list' 查看所有会话和对应的 UID`);
          process.exitCode = 1;
          return;
        }
        targetCid = buildPrivateCid(myUid, target.uid);
        log.info(`仅监控会话: ${target.nickname} cid=${targetCid}`);
      }

      // 会话映射（cid -> 昵称）
      const cidToNickname = new Map<string, string>();
      for (const c of contacts) {
        cidToNickname.set(c.conversationId, c.nickname);
      }

      // 获取 access_key：优先用 --access-key，否则自动提取（提取后关闭浏览器）
      let accessKey = opts.accessKey;
      let deviceId = opts.deviceId || myUid;
      if (!accessKey) {
        log.info('未指定 --access-key，启动浏览器自动提取（提取后关闭浏览器，纯 API 运行）...');
        try {
          const { path: statePath } = await resolveStorageState(globalState, globalAccount);
          const extracted = await extractWsAccessKey(statePath);
          accessKey = extracted.accessKey;
          if (!opts.deviceId) deviceId = extracted.deviceId;
          log.info(`提取成功: access_key=${accessKey.slice(0, 8)}... device_id=${deviceId}`);
        } catch (e) {
          log.error('自动提取 access_key 失败', e);
          log.error('可手动指定: sprr watch --access-key <key> --device-id <uid>');
          log.error('或从浏览器 DevTools → Network → WS 中复制 access_key 参数');
          process.exitCode = 1;
          return;
        }
      }

      // 已知 msg_id 去重（避免同一推送重复显示）
      const seenMsgIds = new Set<string>();

      log.info(`[watch] 开始监听（纯 Node.js WebSocket，带 Cookie）`);
      log.info(`  access_key=${accessKey.slice(0, 8)}... device_id=${deviceId}`);
      log.info('-'.repeat(80));

      const conn = connectFrontier({
        accessKey,
        deviceId,
        cookie: session.cookie,
        onOpen: () => {
          log.info('[watch] 已连接到 Frontier WebSocket，等待消息推送...');
          log.info('-'.repeat(80));
        },
        onFrame: (frame) => {
          handleFrame(frame);
        },
        onReconnect: (attempt, delayMs) => {
          log.warn(`[watch] 连接断开，${delayMs}ms 后第 ${attempt} 次重连...`);
        },
        onClose: (code, reason) => {
          log.warn(`[watch] 连接关闭 code=${code} reason=${reason}（已停止重连）`);
        },
        onError: (err) => {
          log.error('[watch] WebSocket 错误', err);
        },
      });

      // 优雅退出
      const cleanup = () => {
        log.info('\n[watch] 正在关闭...');
        conn.close();
        process.exit(0);
      };
      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);

      /** 处理每一帧推送 */
      function handleFrame(frame: FrontierFrame): void {
        if (opts.raw) {
          log.info(`[raw] msgId=${frame.msgId} ts=${frame.serverTimestamp}`);
          if (frame.payloadRaw) {
            log.info(`  payload: ${frame.payloadRaw.slice(0, 200)}...`);
          }
          return;
        }
        if (!frame.payload) {
          if (frame.msgId) {
            log.debug(`[frame] msg_id=${frame.msgId}（无 payload）`);
          }
          return;
        }
        const p = frame.payload;
        // msgType=500 表示新消息，其他为会话更新
        if (p.msgType !== 500) {
          if (p.conversationId) {
            const name = cidToNickname.get(p.conversationId) || '(未知会话)';
            log.info(`[通知] type=${p.msgType} 会话=${name}`);
          }
          return;
        }
        // 新消息
        const cid = p.conversationId;
        if (!cid) {
          log.debug('[watch] 新消息帧无 conversation_id');
          return;
        }
        // 如果指定了 --to，过滤其他会话
        if (targetCid && cid !== targetCid) return;

        // 去重
        if (frame.msgId && seenMsgIds.has(frame.msgId)) return;
        if (frame.msgId) seenMsgIds.add(frame.msgId);
        if (seenMsgIds.size > 200) {
          const first = seenMsgIds.values().next().value;
          if (first) seenMsgIds.delete(first);
        }

        const nickname = cidToNickname.get(cid) || '(未知会话)';
        const sender = p.direction === 1 ? '我' : p.direction === 2 ? '对方' : '?';
        const aweTypeTag = p.aweType !== undefined ? `[aweType:${p.aweType}]` : '';
        const text = p.text || '(非文本消息)';
        log.info(`[新消息] ${nickname} | ${sender}: ${text} ${aweTypeTag}`);
      }
    });
  });

/* ----------------------------- profile 命令 ----------------------------- */

program
  .command('profile')
  .description('获取当前账号主页信息（头像/昵称/抖音号/简介/关注/粉丝/获赞）')
  .action(async () => {
    await run(async ({ env }) => {
      const { getSelfProfile } = await import('./commands/profile.js');
      const profile = await getSelfProfile(env);
      if (globalJson) {
        console.log(JSON.stringify(profile, null, 2));
        return;
      }
      log.info('='.repeat(60));
      log.info(`  昵称: ${profile.nickname}`);
      log.info(`  抖音号: ${profile.uniqueId || '(未设置)'}`);
      log.info(`  UID: ${profile.uid}`);
      log.info(`  sec_uid: ${profile.secUid}`);
      log.info(`  简介: ${profile.signature || '(无)'}`);
      log.info(`  关注: ${profile.followingCount ?? '?'}`);
      log.info(`  粉丝: ${profile.followerCount ?? '?'}`);
      log.info(`  获赞: ${profile.totalFavorited ?? '?'}`);
      log.info(`  作品: ${profile.awemeCount ?? '?'}`);
      if (profile.country) log.info(`  地区: ${profile.country}`);
      if (profile.bindPhone) log.info(`  绑定手机: ${profile.bindPhone}`);
      if (profile.avatarUrl) log.info(`  头像: ${profile.avatarUrl}`);
      log.info('='.repeat(60));
    });
  });

/* ----------------------------- edit-profile 命令 ----------------------------- */

program
  .command('edit-profile')
  .description('修改个人资料（昵称/简介/头像）。头像走纯 API ImageX 上传，资料修改走纯 API + a_bogus 签名')
  .option('--nickname <text>', '新昵称')
  .option('--signature <text>', '新简介')
  .option('--avatar <path>', '头像本地文件路径')
  .action(async (opts: { nickname?: string; signature?: string; avatar?: string }) => {
      await run(async ({ env, session }) => {
        const { editProfile } = await import('./commands/profile.js');
        // 写接口需要 ticket-guard 三头，自动加载或提取
        let ticketGuard: import('./api/webapi.js').TicketGuardHeaders | undefined;
        let cfg = await loadOrExtractTicketGuard(false);
        if (!cfg) {
          log.info('edit-profile: 未找到 ticket-guard 配置，自动获取...');
          const { path: statePath } = await resolveStorageState(globalState, globalAccount);
          const autoCfg = await autoExtractTicketGuard(statePath, { headless: true });
          if (autoCfg) {
            await saveTicketGuard(autoCfg);
            cfg = autoCfg;
          }
        }
        if (cfg) {
          ticketGuard = {
            clientData: cfg.clientData,
            reePublicKey: cfg.reePublicKey,
            sessionDtrait: cfg.sessionDtrait,
          };
          log.info(`edit-profile: ticket-guard 已加载（来源: ${cfg.capturedFrom}）`);
        } else {
          log.warn('edit-profile: ticket-guard 获取失败，尝试不带三头发送...');
        }
        const result = await editProfile({
          nickname: opts.nickname,
          signature: opts.signature,
          avatarPath: opts.avatar,
        }, env, session.uid || '', ticketGuard);
      if (globalJson) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (result.success) {
        log.info(result.message);
        if (result.profile) {
          log.info(`  昵称: ${result.profile.nickname}`);
          log.info(`  抖音号: ${result.profile.uniqueId || '(未设置)'}`);
          log.info(`  简介: ${result.profile.signature || '(无)'}`);
          if (result.profile.avatarUrl) log.info(`  头像: ${result.profile.avatarUrl}`);
        }
      } else {
        log.error(`修改失败: ${result.message}`);
        process.exitCode = 1;
      }
    });
  });

/* ----------------------------- notices 命令 ----------------------------- */

program
  .command('notices')
  .description('获取互动消息列表（点赞/评论/新粉丝等）')
  .option('--count <n>', '每页数量（默认 20）', '20')
  .option('--max <n>', '最大拉取条数（默认 50）', '50')
  .action(async (opts: { count: string; max: string }) => {
    await run(async ({ env }) => {
      const { getNotices } = await import('./commands/profile.js');
      const count = parseInt(opts.count, 10);
      const maxItems = parseInt(opts.max, 10);
      const items: Awaited<ReturnType<typeof getNotices>>['items'] = [];
      const seenNids = new Set<string>();
      // 分页游标：用「本页最旧消息的 createTime」作为下次的 max_time，获取更旧的消息
      // 抓包+实测确认：notice 接口的响应 min_time 字段是「未读消息下界」而非本页最旧时间，
      // 直接用作下次 min_time 会陷入死循环（每次返回相同结果）
      let maxTime = 0;
      let hasMore = true;
      while (items.length < maxItems && hasMore) {
        const page = await getNotices(env, { count, minTime: 0, maxTime });
        if (page.items.length === 0) break;
        let added = 0;
        for (const it of page.items) {
          if (!seenNids.has(it.nid)) {
            seenNids.add(it.nid);
            items.push(it);
            added++;
            if (items.length >= maxItems) break;
          }
        }
        // 更新游标为本页最旧消息的 createTime
        const oldest = page.items[page.items.length - 1]?.createTime ?? 0;
        if (oldest <= 0 || added === 0) {
          // 没有新内容或时间戳异常，停止
          hasMore = false;
          break;
        }
        maxTime = oldest;
        hasMore = page.hasMore;
        if (page.items.length < count) break;
      }

      if (globalJson) {
        console.log(JSON.stringify({ items, hasMore, count: items.length }, null, 2));
        return;
      }
      log.info(`共 ${items.length} 条互动消息${hasMore ? '（还有更多）' : ''}`);
      log.info('-'.repeat(80));
      for (const n of items) {
        const time = new Date(n.createTime * 1000).toLocaleString('zh-CN', { hour12: false });
        const typeLabel = noticeTypeLabel(n.type);
        const from = n.fromNickname || '?';
        const label = n.labelText ? ` ${n.labelText}` : '';
        const desc = n.awemeDesc ? `《${truncate(n.awemeDesc, 30)}》` : '';
        const comment = n.commentText ? ` 评论:"${truncate(n.commentText, 40)}"` : '';
        const merge = n.mergeCount && n.mergeCount > 1 ? ` (×${n.mergeCount})` : '';
        const readTag = n.hasRead ? '' : ' [未读]';
        log.info(`[${time}] [${typeLabel}] ${from}${merge}${label}${desc}${comment}${readTag}`);
        if (n.awemeId) log.info(`  aweme_id=${n.awemeId}`);
        if (n.commentId) log.info(`  comment_id=${n.commentId}`);
        if (n.fromSecUid) log.info(`  from_sec_uid=${n.fromSecUid}`);
        if (n.nid) log.info(`  notice_id=${n.nid}`);
      }
      log.info('-'.repeat(80));
    });
  });

/* ----------------------------- noticedetail 命令 ----------------------------- */

program
  .command('noticedetail')
  .description('查询单条通知详情（按 notice_id 获取完整跳转参数）')
  .requiredOption('--nid <id>', '通知 ID（notice_id，可从 notices 命令获取）')
  .action(async (opts: { nid: string }) => {
    await run(async ({ env }) => {
      const { getNoticeDetail } = await import('./commands/profile.js');
      const n = await getNoticeDetail(env, opts.nid);
      if (!n) {
        log.warn(`未找到通知: nid=${opts.nid}`);
        return;
      }
      if (globalJson) {
        console.log(JSON.stringify(n, null, 2));
        return;
      }
      const time = new Date(n.createTime * 1000).toLocaleString('zh-CN', { hour12: false });
      const typeLabel = noticeTypeLabel(n.type);
      log.info(`通知详情: nid=${n.nid}`);
      log.info('-'.repeat(80));
      log.info(`时间: ${time}`);
      log.info(`类型: ${typeLabel} (type=${n.type})`);
      log.info(`已读: ${n.hasRead ? '是' : '否'}`);
      if (n.fromNickname) log.info(`触发用户: ${n.fromNickname}`);
      if (n.fromUid) log.info(`  from_uid=${n.fromUid}`);
      if (n.fromSecUid) log.info(`  from_sec_uid=${n.fromSecUid}`);
      if (n.awemeId) log.info(`关联视频: aweme_id=${n.awemeId}`);
      if (n.awemeDesc) log.info(`  描述: ${truncate(n.awemeDesc, 60)}`);
      if (n.authorNickname) log.info(`  作者: ${n.authorNickname}`);
      if (n.commentId) log.info(`关联评论: comment_id=${n.commentId}`);
      if (n.commentText) log.info(`  内容: ${truncate(n.commentText, 60)}`);
      if (n.schemaUrl) log.info(`跳转链接: ${n.schemaUrl}`);
      if (n.schemaText) log.info(`跳转文案: ${n.schemaText}`);
      if (n.labelText) log.info(`标签: ${n.labelText}`);
      log.info('-'.repeat(80));
    });
  });

/* ----------------------------- awemedetail 命令 ----------------------------- */

program
  .command('awemedetail')
  .description('查询单个视频详情（来自通知 aweme_id，解析通知来源视频）')
  .requiredOption('--aweme-id <id>', '视频 aweme_id（可从 notices/noticedetail 命令获取）')
  .option('--ticket-guard-client-data <v>', 'bd-ticket-guard-client-data 头值（GET 接口通常可省略，仅风控触发时使用）')
  .option('--ticket-guard-ree-public-key <v>', 'bd-ticket-guard-ree-public-key 头值')
  .action(async (opts: {
    awemeId: string;
    ticketGuardClientData?: string;
    ticketGuardReePublicKey?: string;
  }) => {
    await run(async ({ env }) => {
      const ticketGuard: TicketGuardHeaders | undefined = opts.ticketGuardClientData
        ? {
            clientData: opts.ticketGuardClientData,
            reePublicKey: opts.ticketGuardReePublicKey,
          }
        : undefined;
      const detail = await getAwemeDetail(env, opts.awemeId, ticketGuard);
      if (!detail) {
        log.error(`查询失败: aweme_id=${opts.awemeId}`);
        process.exitCode = 1;
        return;
      }
      if (globalJson) {
        console.log(JSON.stringify(detail, null, 2));
        return;
      }
      log.info(`视频详情: aweme_id=${detail.awemeId}`);
      log.info('-'.repeat(80));
      if (detail.desc) log.info(`标题: ${detail.desc}`);
      if (detail.authorNickname) log.info(`作者: ${detail.authorNickname}`);
      if (detail.authorSecUid) log.info(`  sec_uid=${detail.authorSecUid}`);
      if (detail.authorUid) log.info(`  uid=${detail.authorUid}`);
      if (detail.duration) log.info(`时长: ${detail.duration}ms`);
      if (detail.diggCount !== undefined) log.info(`点赞: ${detail.diggCount}`);
      if (detail.commentCount !== undefined) log.info(`评论: ${detail.commentCount}`);
      if (detail.shareCount !== undefined) log.info(`分享: ${detail.shareCount}`);
      if (detail.coverUrl) log.info(`封面: ${detail.coverUrl}`);
      if (detail.playUrl) log.info(`播放: ${detail.playUrl}`);
      if (detail.authenticationToken) log.info(`鉴权 token: ${detail.authenticationToken.slice(0, 40)}...`);
      log.info('-'.repeat(80));
    });
  });

/* ----------------------------- comments 命令 ----------------------------- */

program
  .command('comments')
  .description('获取视频评论列表（支持分页，可指定 aweme_id 或从 notice 直接查询）')
  .requiredOption('--aweme-id <id>', '视频 aweme_id')
  .option('--cursor <n>', '分页游标（默认 0，下一页用上一页返回的 cursor）', '0')
  .option('--count <n>', '每页数量（默认 10）', '10')
  .option('--max <n>', '最大拉取条数（默认 30）', '30')
  .option('--ticket-guard-client-data <v>', 'bd-ticket-guard-client-data 头值（GET 接口通常可省略）')
  .option('--ticket-guard-ree-public-key <v>', 'bd-ticket-guard-ree-public-key 头值')
  .action(async (opts: {
    awemeId: string;
    cursor: string;
    count: string;
    max: string;
    ticketGuardClientData?: string;
    ticketGuardReePublicKey?: string;
  }) => {
    await run(async ({ env }) => {
      const ticketGuard: TicketGuardHeaders | undefined = opts.ticketGuardClientData
        ? {
            clientData: opts.ticketGuardClientData,
            reePublicKey: opts.ticketGuardReePublicKey,
          }
        : undefined;
      const count = parseInt(opts.count, 10);
      const maxItems = parseInt(opts.max, 10);
      const all: CommentInfo[] = [];
      let cursor = parseInt(opts.cursor, 10);
      let hasMore = true;
      while (all.length < maxItems && hasMore) {
        const page = await getCommentList(env, opts.awemeId, { cursor, count }, ticketGuard);
        if (page.comments.length === 0) break;
        all.push(...page.comments);
        cursor = page.cursor;
        hasMore = page.hasMore;
        if (page.comments.length < count) break;
        if (all.length >= maxItems) break;
      }

      if (globalJson) {
        console.log(JSON.stringify({ comments: all.slice(0, maxItems), cursor, hasMore, count: all.length }, null, 2));
        return;
      }
      log.info(`共 ${Math.min(all.length, maxItems)} 条评论${hasMore ? '（还有更多，下一页 cursor=' + cursor + '）' : ''}`);
      log.info('-'.repeat(80));
      for (const c of all.slice(0, maxItems)) {
        const time = new Date(c.createTime * 1000).toLocaleString('zh-CN', { hour12: false });
        const hot = c.isHot ? ' [热]' : '';
        const ip = c.ipLabel ? ` [${c.ipLabel}]` : '';
        const replyTag = c.replyId !== '0' ? ` 回复${c.replyId}` : '';
        log.info(`[${time}] ${c.userNickname}${ip}${replyTag}${hot}: ${c.text}`);
        log.info(`  cid=${c.commentId} uid=${c.userId} 点赞=${c.diggCount} 回复数=${c.replyCount}`);
      }
      log.info('-'.repeat(80));
    });
  });

/* ----------------------------- comment 命令（评论发布/回复） ----------------------------- */

program
  .command('comment')
  .description('发布评论或回复评论（自动从 data/ticket-guard.json 加载 bd-ticket-guard-* 和 x-tt-session-dtrait 三头；也可手动指定）')
  .requiredOption('--aweme-id <id>', '目标视频 aweme_id')
  .requiredOption('--text <content>', '评论内容')
  .option('--reply-id <cid>', '被回复评论 cid（不传则发布顶级评论）')
  .option('--at-uid <uid>', '@用户 uid（可多个，逗号分隔）')
  .option('--at-sec-uid <sec_uid>', '@用户 sec_uid（与 at-uid 一一对应，逗号分隔）')
  .option('--ticket-guard-client-data <v>', 'bd-ticket-guard-client-data 头值（手动指定，优先于配置文件）')
  .option('--ticket-guard-ree-public-key <v>', 'bd-ticket-guard-ree-public-key 头值（手动指定）')
  .option('--tt-session-dtrait <v>', 'x-tt-session-dtrait 头值（手动指定）')
  .action(async (opts: {
    awemeId: string;
    text: string;
    replyId?: string;
    atUid?: string;
    atSecUid?: string;
    ticketGuardClientData?: string;
    ticketGuardReePublicKey?: string;
    ttSessionDtrait?: string;
  }) => {
    await run(async ({ env, session }) => {
      // 1. 优先使用 CLI 手动指定的三头
      let ticketGuard: TicketGuardHeaders;
      if (opts.ticketGuardClientData && opts.ticketGuardReePublicKey && opts.ttSessionDtrait) {
        ticketGuard = {
          clientData: opts.ticketGuardClientData,
          reePublicKey: opts.ticketGuardReePublicKey,
          sessionDtrait: opts.ttSessionDtrait,
        };
        log.info('comment: 使用 CLI 手动指定的 ticket-guard 三头');
      } else {
        // 2. 自动从 data/ticket-guard.json 加载（不存在则尝试从抓包数据提取）
        let cfg = await loadOrExtractTicketGuard(false);
        // 3. 若加载失败，自动启动浏览器获取（headless，用户无感）
        if (!cfg) {
          log.info('comment: 未找到已保存的 ticket-guard 配置，自动启动浏览器获取...');
          log.info('comment: 浏览器将以无头模式运行，无需手动操作');
          const { path: statePath } = await resolveStorageState(globalState, globalAccount);
          const autoCfg = await autoExtractTicketGuard(statePath, { headless: true });
          if (autoCfg) {
            await saveTicketGuard(autoCfg);
            cfg = autoCfg;
            log.info('comment: 浏览器自动获取三头成功，已保存到 data/ticket-guard.json');
          } else {
            log.error('comment: 浏览器自动获取三头失败');
            log.error('  方式1: 运行 `sprr ticket-guard --auto` 单独尝试浏览器自动获取');
            log.error('  方式2: 运行 `sprr ticket-guard --from-capture` 从抓包数据提取');
            log.error('  方式3: 运行 `sprr ticket-guard --client-data ... --ree-public-key ... --session-dtrait ...` 手动导入');
            log.error('  方式4: 在 comment 命令中直接指定 --ticket-guard-client-data / --ticket-guard-ree-public-key / --tt-session-dtrait');
            process.exitCode = 1;
            return;
          }
        }
        if (isTicketGuardExpired(cfg)) {
          log.warn(
            `comment: ticket-guard 配置可能已过期（抓包于 ${new Date(cfg.capturedAt).toLocaleString('zh-CN', { hour12: false })}），如发布失败请运行 sprr ticket-guard --auto 重新获取`,
          );
        }
        ticketGuard = {
          clientData: cfg.clientData,
          reePublicKey: cfg.reePublicKey,
          sessionDtrait: cfg.sessionDtrait,
        };
        log.info(`comment: 使用配置文件中的 ticket-guard 三头（来源: ${cfg.capturedFrom}）`);
      }

      // 构造 text_extra（@用户元数据）
      let textExtra: Array<{ user_id: string; sec_uid: string; type: number; start: number; end: number }> = [];
      if (opts.atUid && opts.atSecUid) {
        const uids = opts.atUid.split(',').map((s) => s.trim()).filter(Boolean);
        const secUids = opts.atSecUid.split(',').map((s) => s.trim()).filter(Boolean);
        if (uids.length !== secUids.length) {
          log.error('--at-uid 和 --at-sec-uid 数量不一致');
          process.exitCode = 1;
          return;
        }
        // 计算 @ 用户在 text 中的位置（简化：按 @nickname 顺序查找；如未找到则位置填 0）
        let searchStart = 0;
        for (let i = 0; i < uids.length; i++) {
          const atText = `@${i + 1}`; // 简化占位符，实际应匹配 @nickname
          const idx = opts.text.indexOf(atText, searchStart);
          const start = idx >= 0 ? idx : 0;
          const end = idx >= 0 ? idx + atText.length : 0;
          textExtra.push({
            user_id: uids[i],
            sec_uid: secUids[i],
            type: 0,
            start,
            end,
          });
          if (idx >= 0) searchStart = end;
        }
      }

      const result = await publishComment(
        env,
        {
          awemeId: opts.awemeId,
          text: opts.text,
          replyId: opts.replyId,
          textExtra,
        },
        ticketGuard,
      );
      if (!result.success) {
        log.error(`评论发布失败: aweme_id=${opts.awemeId} reply=${opts.replyId || '(top)'}`);
        if (globalJson && result.raw) {
          console.log(JSON.stringify({ success: false, raw: result.raw }, null, 2));
        }
        process.exitCode = 1;
        return;
      }
      if (globalJson) {
        console.log(JSON.stringify({ success: true, commentId: result.commentId }, null, 2));
        return;
      }
      log.info(`评论发布成功: cid=${result.commentId}`);
      log.info(`  aweme_id=${opts.awemeId}`);
      log.info(`  reply_id=${opts.replyId || '(top-level)'}`);
      log.info(`  text=${opts.text}`);
    });
  });

/* --------------------------- ticket-guard 命令（三头管理） --------------------------- */

program
  .command('ticket-guard')
  .description('管理 bd-ticket-guard 浏览器加密签名头（评论发布必需）')
  .option('--auto', '启动无头浏览器自动获取三头（推荐，仅需已登录的 cookie）')
  .option('--from-capture', '从 data/capture/interact/requests/ 自动提取最新的 comment_publish 抓包样本')
  .option('--client-data <v>', '手动指定 bd-ticket-guard-client-data 头值')
  .option('--ree-public-key <v>', '手动指定 bd-ticket-guard-ree-public-key 头值')
  .option('--session-dtrait <v>', '手动指定 x-tt-session-dtrait 头值')
  .option('--show', '显示当前已保存的配置')
  .action(async (opts: {
    auto?: boolean;
    fromCapture?: boolean;
    clientData?: string;
    reePublicKey?: string;
    sessionDtrait?: string;
    show?: boolean;
  }) => {
    // --show: 显示当前配置
    if (opts.show) {
      const cfg = await loadTicketGuard();
      if (!cfg) {
        log.info('当前无已保存的 ticket-guard 配置');
        log.info('推荐使用 `sprr ticket-guard --auto` 自动获取（仅需已登录的 cookie）');
        log.info('或 `sprr ticket-guard --client-data ... --ree-public-key ... --session-dtrait ...` 手动导入');
        return;
      }
      if (globalJson) {
        console.log(JSON.stringify(cfg, null, 2));
        return;
      }
      log.info('='.repeat(60));
      log.info(`来源: ${cfg.capturedFrom}`);
      log.info(`抓包时间: ${new Date(cfg.capturedAt).toLocaleString('zh-CN', { hour12: false })}`);
      const expired = isTicketGuardExpired(cfg);
      log.info(`状态: ${expired ? '可能已过期（建议重新获取）' : '有效'}`);
      log.info('-'.repeat(60));
      log.info(`bd-ticket-guard-client-data (${cfg.clientData.length} chars):`);
      log.info(`  ${cfg.clientData.slice(0, 80)}...`);
      log.info(`bd-ticket-guard-ree-public-key (${cfg.reePublicKey.length} chars):`);
      log.info(`  ${cfg.reePublicKey}`);
      log.info(`x-tt-session-dtrait (${cfg.sessionDtrait.length} chars):`);
      log.info(`  ${cfg.sessionDtrait.slice(0, 80)}...`);
      log.info('='.repeat(60));
      return;
    }

    // --auto: 启动无头浏览器自动获取（推荐方式）
    if (opts.auto) {
      const { path: statePath } = await resolveStorageState(globalState, globalAccount);
      const extracted = await autoExtractTicketGuard(statePath, { headless: true });
      if (!extracted) {
        log.error('浏览器自动获取三头失败');
        log.error('可能原因：1) cookie 已过期（请重新 sprr login）；2) 未安装 playwright（运行 npm install -D playwright）');
        log.error('降级方案: sprr ticket-guard --from-capture 从抓包数据提取');
        log.error('或手动导入: sprr ticket-guard --client-data ... --ree-public-key ... --session-dtrait ...');
        process.exitCode = 1;
        return;
      }
      await saveTicketGuard(extracted);
      if (globalJson) {
        console.log(JSON.stringify(extracted, null, 2));
        return;
      }
      log.info('ticket-guard 三头自动获取成功:');
      log.info(`  来源: ${extracted.capturedFrom}`);
      log.info(`  获取时间: ${new Date(extracted.capturedAt).toLocaleString('zh-CN', { hour12: false })}`);
      log.info(`  clientData: ${extracted.clientData.length} chars`);
      log.info(`  reePublicKey: ${extracted.reePublicKey.length} chars`);
      log.info(`  sessionDtrait: ${extracted.sessionDtrait.length} chars`);
      return;
    }

    // --from-capture: 从抓包数据自动提取（开发者模式）
    if (opts.fromCapture) {
      const extracted = await extractTicketGuardFromCapture();
      if (!extracted) {
        log.error('从抓包数据提取失败：未找到包含完整三头的 comment_publish 样本');
        log.error(`请确认抓包目录存在: ${path.join(DATA_DIR, 'capture', 'interact', 'requests')}`);
        log.error('推荐使用 `sprr ticket-guard --auto` 自动获取（无需抓包数据）');
        log.error('或手动导入: sprr ticket-guard --client-data ... --ree-public-key ... --session-dtrait ...');
        process.exitCode = 1;
        return;
      }
      await saveTicketGuard(extracted);
      if (globalJson) {
        console.log(JSON.stringify(extracted, null, 2));
        return;
      }
      log.info('ticket-guard 三头提取成功:');
      log.info(`  来源: ${extracted.capturedFrom}`);
      log.info(`  抓包时间: ${new Date(extracted.capturedAt).toLocaleString('zh-CN', { hour12: false })}`);
      log.info(`  clientData: ${extracted.clientData.length} chars`);
      log.info(`  reePublicKey: ${extracted.reePublicKey.length} chars`);
      log.info(`  sessionDtrait: ${extracted.sessionDtrait.length} chars`);
      return;
    }

    // 手动导入
    if (opts.clientData && opts.reePublicKey && opts.sessionDtrait) {
      const cfg: TicketGuardConfig = {
        clientData: opts.clientData,
        reePublicKey: opts.reePublicKey,
        sessionDtrait: opts.sessionDtrait,
        capturedAt: Date.now(),
        capturedFrom: 'manual',
      };
      await saveTicketGuard(cfg);
      if (globalJson) {
        console.log(JSON.stringify(cfg, null, 2));
        return;
      }
      log.info('ticket-guard 三头手动导入成功');
      return;
    }

    // 无参数：显示帮助
    log.info('用法:');
    log.info('  sprr ticket-guard --auto                 自动启动无头浏览器获取三头（推荐）');
    log.info('  sprr ticket-guard --from-capture          从抓包数据自动提取三头（开发者模式）');
    log.info('  sprr ticket-guard --show                  显示当前已保存的配置');
    log.info('  sprr ticket-guard --client-data <v> --ree-public-key <v> --session-dtrait <v>  手动导入');
  });

/** 互动消息类型转中文标签（基于抓包确认的类型码 + 字段路径） */
function noticeTypeLabel(type: number): string {
  switch (type) {
    case 8:
      return '新粉丝';
    case 31:
      return '评论'; // n.comment.comment
    case 33:
      return '新粉丝'; // n.follow.from_user（抓包确认 type=33 是新粉丝通知）
    case 41:
      return '点赞'; // n.digg
    case 45:
      return '@提及'; // n.at（抓包确认 type=45 是 @提及，非"回复"）
    case 42:
      return '评论';
    case 44:
      return '@我';
    default:
      return `type=${type}`;
  }
}

function truncate(s: string, max: number): string {
  const lines = s.replace(/\n/g, ' ').trim();
  return lines.length > max ? lines.slice(0, max) + '...' : lines;
}

/* ----------------------------- 辅助函数 ----------------------------- */

/**
 * 加载 session 并执行回调
 *
 * 优先级：--cookie > --state > --account > 当前账号指针 > 默认兜底
 */
async function run(
  fn: (ctx: { env: ReturnType<typeof envFromSession>; session: SessionData }) => Promise<void>,
): Promise<void> {
  let session: SessionData;
  try {
    if (globalCookie) {
      // 优先使用 --cookie 直接传入的 cookie 字符串
      log.debug('使用 --cookie 参数（直接传入 cookie 字符串）');
      session = sessionFromCookieString(globalCookie);
    } else {
      const { path: statePath, source } = await resolveStorageState(globalState, globalAccount);
      log.debug(`使用 storageState: ${statePath}（来源: ${source}）`);
      session = await loadFromStorageState(statePath);
    }
  } catch (e) {
    log.error('加载 session 失败', e);
    if (globalState || globalAccount || globalCookie) {
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
  } catch (e) {
    log.error('执行失败', e);
    process.exitCode = 1;
  }
}

/** 已加载的联系人缓存（避免每次 resolveTarget 都重新拉取） */
let _contactsCache: ContactItem[] | null = null;

/**
 * 获取 storageState 文件路径（用于需要启动浏览器的功能，如 ticket-guard/watch）
 *
 * 当使用 --cookie 模式时，把 cookie 字符串写成临时 storageState 文件。
 * 其他情况走 resolveStorageState。
 */
async function getStatePathForBrowser(): Promise<string> {
  if (globalCookie) {
    // 把 cookie 字符串写成临时 storageState 文件
    const tmpPath = path.join(DATA_DIR, 'tmp-cookie-state.json');
    const cookies = globalCookie
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => {
        const idx = pair.indexOf('=');
        const name = idx > 0 ? pair.slice(0, idx) : pair;
        const value = idx > 0 ? pair.slice(idx + 1) : '';
        return { name, value, domain: '.douyin.com', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const };
      });
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(tmpPath, JSON.stringify({ cookies, origins: [] }, null, 2), 'utf-8');
    return tmpPath;
  }
  const { path: statePath } = await resolveStorageState(globalState, globalAccount);
  return statePath;
}

async function getContacts(env: ReturnType<typeof envFromSession>): Promise<ContactItem[]> {
  if (!_contactsCache) {
    _contactsCache = await listContacts(env);
    // 自动获取 nickname（与 list 命令一致）
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

/**
 * 解析目标用户：支持直接传 uid、cid，或通过昵称在会话列表中查找
 */
async function resolveTarget(
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
  let match = contacts.find(
    (c) => c.nickname === target || c.remark === target,
  );
  // 4. 模糊匹配
  if (!match) {
    match = contacts.find(
      (c) => c.nickname.includes(target) || (c.remark?.includes(target) ?? false),
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

/**
 * 格式化单条消息为一行显示
 *
 * 格式: [时间] [消息类型标签] 发送者: 内容
 *   消息类型标签：[文本] [分享视频] [AI回复] [系统提示] [图片] [表情] [未知]
 *   发送者：我 / 对方 / 小火人 / 系统
 */
function formatMessageLine(m: MessageItem): string {
  const ts = m.timestamp
    ? new Date(m.timestamp).toLocaleString('zh-CN', { hour12: false })
    : '                   ';
  const typeTag = formatCategoryTag(m.category);
  const sender = m.senderLabel.padEnd(3, ' ');
  let content: string;
  if (m.category === 'video_share') {
    // 视频分享：显示作者 + 标题
    const author = m.videoAuthor ? `作者:${m.videoAuthor} ` : '';
    content = `${author}${m.text || '(无标题)'}`;
  } else if (m.category === 'system_tip') {
    content = m.text || '(系统提示)';
  } else if (m.category === 'image') {
    // 图片：显示 [图片] + URL（如果有）
    content = m.stickerUrl ? `${m.text || '[图片]'} ${m.stickerUrl}` : (m.text || '[图片]');
  } else if (m.category === 'sticker') {
    // 表情贴纸：显示描述 + 图片 URL（便于查看原图）
    content = m.stickerUrl ? `${m.text} ${m.stickerUrl}` : (m.text || '[表情]');
  } else if (m.category === 'recall') {
    // 撤回消息：显示撤回提示
    content = m.text || '撤回了一条消息';
  } else {
    content = m.text || '(空消息)';
  }
  const idSuffix = m.serverMsgId ? ` [id:${m.serverMsgId}]` : '';
  return `  [${ts}] ${typeTag} ${sender}: ${content}${idSuffix}`;
}

/** 消息类别标签（固定宽度，便于对齐） */
function formatCategoryTag(category: string): string {
  switch (category) {
    case 'text':       return '[文本]    ';
    case 'video_share':return '[分享视频]';
    case 'ai_text':    return '[AI回复]  ';
    case 'system_tip': return '[系统提示]';
    case 'image':      return '[图片]    ';
    case 'sticker':    return '[表情]    ';
    case 'recall':     return '[撤回]    ';
    default:           return '[未知]    ';
  }
}

/**
 * 简单的 ASCII 表格格式化
 */
function formatTable(
  headers: string[],
  rows: string[][],
): string {
  const widths = headers.map((h, i) => {
    const maxRowLen = Math.max(...rows.map((r) => (r[i] || '').length));
    return Math.max(h.length, maxRowLen);
  });
  const pad = (s: string, i: number) => (s || '').padEnd(widths[i]);
  const sep = '-'.repeat(widths.reduce((a, b) => a + b + 3, 0));
  const headerLine = headers.map(pad).join(' | ');
  const rowLines = rows.map((r) => r.map(pad).join(' | '));
  return [headerLine, sep, ...rowLines].join('\n');
}

/**
 * 输出结果：JSON 模式直接打印 JSON，否则走回调
 */
function output<T>(
  data: T,
  pretty: (data: T) => void,
): void {
  if (globalJson) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else {
    pretty(data);
  }
}

program.parseAsync(process.argv).catch((e) => {
  log.error('命令执行异常', e);
  process.exitCode = 1;
});
