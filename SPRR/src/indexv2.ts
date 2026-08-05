#!/usr/bin/env node
/**
 * SPRR V2 - 抖音私信聊天自动化工具（交互式 REPL 版本）
 *
 * 与 V1 (index.ts) 的区别：
 * - 启动时加载 MACT.txt 小猫 ASCII 艺术
 * - 交互式 REPL：执行完命令后不退出，可继续输入下一条命令
 * - 会话/联系人缓存：首次命令加载后复用，避免重复请求
 * - 彩色输出：提示符、分隔线、统计信息等使用 ANSI 颜色
 *
 * 内置命令：
 *   help    显示帮助
 *   clear   清屏
 *   reload  清除会话缓存（切换账号后使用）
 *   exit    退出
 *
 * 用法：
 *   pnpm dev:v2
 *   node dist/indexv2.js
 */

import { Command } from 'commander';
import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createLogger } from './utils/logger.js';
import { DATA_DIR } from './config/paths.js';
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
import { extractWsAccessKey } from './commands/extract-ws-key.js';
import { autoExtractTicketGuard } from './commands/ticket-guard-auto.js';
import { handleIncomingMessage, handleIncomingMessageViaHistory, refreshWhitelist, getWhitelist, addWhitelist, removeWhitelist, processUnreadMessages, setBrowserSender } from './ai-reply.js';
import { captureSendRequests } from './commands/capture-send.js';
import { sendViaBrowser, sendQuoteReplyViaBrowser, BrowserSender, type BrowserSendSign } from './commands/browser-send.js';

// ============================ 颜色常量 ============================

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
};

// ============================ 全局状态 ============================

const log = createLogger('cli-v2');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MACT_FILE = path.join(__dirname, 'MACT.txt');
const ALIAS_FILE = path.join(DATA_DIR, 'aliases.json');

let globalVerbose = false;
let globalJson = false;
let globalState: string | undefined;
let globalAccount: string | undefined;
let globalCookie: string | undefined;

/** 缓存的 session（首次命令加载后复用） */
let _session: SessionData | null = null;
let _env: ReturnType<typeof envFromSession> | null = null;
/** 缓存的联系人列表 */
let _contactsCache: ContactItem[] | null = null;

// ============================ 辅助函数 ============================

async function loadAliases(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(ALIAS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveAliases(aliases: Record<string, string>): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(ALIAS_FILE, JSON.stringify(aliases, null, 2), 'utf-8');
}

/** 加载并缓存 session，后续命令复用 */
async function ensureSession(): Promise<{
  session: SessionData;
  env: ReturnType<typeof envFromSession>;
}> {
  if (_session && _env) return { session: _session, env: _env };
  if (globalCookie) {
    // 优先使用 --cookie 直接传入的 cookie 字符串（适用于从 APP 抓包的实时有效 cookie）
    log.debug('使用直接传入的 cookie 字符串（无需登录）');
    _session = sessionFromCookieString(globalCookie);
  } else {
    const { path: statePath, source } = await resolveStorageState(globalState, globalAccount);
    log.debug(`使用 storageState: ${statePath}（来源: ${source}）`);
    _session = await loadFromStorageState(statePath);
  }
  _env = envFromSession(_session);
  return { session: _session, env: _env };
}

/** 设置 cookie 字符串（REPL 内 cookie 命令调用），同时清除缓存 */
function setCookie(cookieStr: string): void {
  globalCookie = cookieStr;
  clearCache();
}

/** 清除缓存（切换账号 / reload 命令时调用） */
function clearCache(): void {
  _session = null;
  _env = null;
  _contactsCache = null;
}

/**
 * 获取用于浏览器相关功能（watch / ticket-guard 自动获取）的 storageState 文件路径
 *
 * 在 --cookie 模式下，把 cookie 字符串写成临时 storageState 文件，
 * 让依赖浏览器的功能（extractWsAccessKey / autoExtractTicketGuard）也能工作。
 */
async function getStatePathForBrowser(): Promise<string> {
  if (globalCookie) {
    const tmpPath = path.join(DATA_DIR, 'tmp-cookie-state.json');
    const cookies = globalCookie
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
  const { path: statePath } = await resolveStorageState(globalState, globalAccount);
  return statePath;
}

/** 加载 session 并执行回调（复用缓存） */
async function run(
  fn: (ctx: { env: ReturnType<typeof envFromSession>; session: SessionData }) => Promise<void>,
): Promise<void> {
  try {
    const { env, session } = await ensureSession();
    await fn({ env, session });
  } catch (e) {
    log.error('执行失败', e);
  }
}

/** 获取联系人列表（缓存） */
async function getContacts(env: ReturnType<typeof envFromSession>): Promise<ContactItem[]> {
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

/** 解析目标用户 */
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

function formatMessageLine(m: MessageItem): string {
  const ts = m.timestamp
    ? new Date(m.timestamp).toLocaleString('zh-CN', { hour12: false })
    : '                   ';
  const typeTag = formatCategoryTag(m.category);
  const sender = m.senderLabel.padEnd(3, ' ');
  let content: string;
  if (m.category === 'video_share') {
    const author = m.videoAuthor ? `作者:${m.videoAuthor} ` : '';
    content = `${author}${m.text || '(无标题)'}`;
  } else if (m.category === 'system_tip') {
    content = m.text || '(系统提示)';
  } else if (m.category === 'image') {
    content = m.stickerUrl ? `${m.text || '[图片]'} ${m.stickerUrl}` : (m.text || '[图片]');
  } else if (m.category === 'sticker') {
    content = m.stickerUrl ? `${m.text} ${m.stickerUrl}` : (m.text || '[表情]');
  } else if (m.category === 'recall') {
    content = m.text || '撤回了一条消息';
  } else {
    content = m.text || '(空消息)';
  }
  const idSuffix = m.serverMsgId ? ` ${C.gray}[id:${m.serverMsgId}]${C.reset}` : '';
  return `  ${C.gray}[${ts}]${C.reset} ${typeTag} ${sender}: ${content}${idSuffix}`;
}

function formatCategoryTag(category: string): string {
  const tag = (s: string, color: string) => `${color}[${s}]${C.reset}`;
  const pad = (s: string) => s.padEnd(6, ' ');
  switch (category) {
    case 'text':        return tag(pad('文本'), C.white);
    case 'video_share': return tag('分享视频', C.brightMagenta);
    case 'ai_text':     return tag(pad('AI回复'), C.brightBlue);
    case 'system_tip':  return tag('系统提示', C.gray);
    case 'image':       return tag(pad('图片'), C.brightGreen);
    case 'sticker':     return tag(pad('表情'), C.brightYellow);
    case 'recall':      return tag(pad('撤回'), C.yellow);
    default:            return tag(pad('未知'), C.dim);
  }
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => {
    const maxRowLen = Math.max(...rows.map((r) => (r[i] || '').length));
    return Math.max(h.length, maxRowLen);
  });
  const pad = (s: string, i: number) => (s || '').padEnd(widths[i]);
  const sep = '─'.repeat(widths.reduce((a, b) => a + b + 3, 0));
  const headerLine = headers.map(pad).join(' │ ');
  const rowLines = rows.map((r) => r.map(pad).join(' │ '));
  return [headerLine, sep, ...rowLines].join('\n');
}

function output<T>(data: T, pretty: (data: T) => void): void {
  if (globalJson) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else {
    pretty(data);
  }
}

function noticeTypeLabel(type: number): string {
  switch (type) {
    case 8:  return '新粉丝';
    case 31: return '评论';
    case 33: return '新粉丝';
    case 41: return '点赞';
    case 45: return '@提及';
    case 42: return '评论';
    case 44: return '@我';
    default: return `type=${type}`;
  }
}

function truncate(s: string, max: number): string {
  const lines = s.replace(/\n/g, ' ').trim();
  return lines.length > max ? lines.slice(0, max) + '...' : lines;
}

/** 分隔线 */
function divider(char = '─', len = 80, color = C.gray): string {
  return color + char.repeat(len) + C.reset;
}

/** 剥离 ANSI 颜色码，计算字符串可视宽度 */
function visualWidth(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/**
 * 小猫 + 框 成功提示模板（读取自 SPTTQ/1.txt 风格）
 *
 * 布局：
 *   ⠀∧,,,∧    ~   ┏━━━━━━━━┓
 *   ( ̳• · • ̳)  ~   ┃ 消息 ┃
 *   /       づ  ~   ┗━━━━━━━━┛
 *
 * 框宽自适应消息长度，消息在框内居中。
 *
 * @param message 成功提示文本（可含 ANSI 颜色码）
 * @param opts.color 框线颜色（默认绿色 = 成功）
 */
function catBox(message: string, opts?: { color?: string }): void {
  const color = opts?.color ?? C.green;
  const catColor = C.brightYellow;
  // 小猫 ASCII 艺术（3 行，固定宽度）
  const catLines = [
    '⠀∧,,,∧    ~   ',
    '( ̳• · • ̳)  ~   ',
    '/       づ  ~   ',
  ];
  // 计算消息可视宽度（剔除 ANSI 颜色码）
  const msgWidth = visualWidth(message);
  // 框内宽度 = 消息宽度 + 2（左右各 1 空格 padding），最小 4
  const innerWidth = Math.max(msgWidth + 2, 4);
  const horizontal = '━'.repeat(innerWidth);
  // 居中消息：左右 padding 各 1 空格
  const padding = 1;
  const boxLines = [
    `${color}┏${horizontal}┓${C.reset}`,
    `${color}┃${C.reset}${' '.repeat(padding)}${message}${' '.repeat(padding)}${color}┃${C.reset}`,
    `${color}┗${horizontal}┛${C.reset}`,
  ];
  // 拼接小猫 + 框
  const lines = catLines.map((cat, i) => `${catColor}${cat}${C.reset}${boxLines[i]}`);
  process.stdout.write(lines.join('\n') + '\n');
}

// ============================ 命令注册 ============================

function createProgram(): Command {
  const program = new Command();
  program
    .name('sprr')
    .description('抖音私信聊天自动化工具（交互式 V2）')
    .version('0.0.1')
    .option('--verbose', '输出详细日志（debug 级别）', false)
    .option('--json', '以 JSON 格式输出结果', false)
    .option('--state <path>', 'storageState 文件路径', undefined)
    .option('--account <name>', '临时使用指定账号', undefined)
    .option('--cookie <string>', '直接使用 cookie 字符串（优先级最高，无需登录）', undefined)
    .hook('preAction', () => {
      const opts = program.opts();
      globalVerbose = Boolean(opts.verbose);
      globalJson = Boolean(opts.json);
      if (opts.state) globalState = opts.state;
      if (opts.account) globalAccount = opts.account;
      if (opts.cookie) globalCookie = opts.cookie;
      if (globalVerbose) {
        process.env.SPRR_DEBUG = '1';
      }
    })
    .exitOverride(); // 阻止 commander 调用 process.exit

  /* --------------------------- login --------------------------- */
  program
    .command('login <name>')
    .description('启动浏览器扫码登录（默认沿用上次登录态，加 --oc 强制重新扫码）')
    .option('--timeout <ms>', '登录超时毫秒数', '300000')
    .option('--url <url>', '登录页 URL（默认 https://www.douyin.com/，火山版等特殊账号需指定 https://creator.douyin.com/）')
    .option('--oc', '强制重新扫码登录（覆盖上次 cookie），默认沿用上次登录态')
    .action(async (name: string, opts: { timeout: string; url?: string; oc?: boolean }) => {
      validateAccountName(name);
      const timeout = parseInt(opts.timeout, 10);
      try {
        const mod = await import('./commands/login.js');
        await mod.loginAccount(name, { timeout, url: opts.url, oc: opts.oc });
        clearCache(); // 登录后清除缓存，下次命令重新加载
      } catch (e) {
        log.error('登录失败', e);
      }
    });

  /* --------------------------- accounts --------------------------- */
  program
    .command('accounts')
    .alias('ls')
    .description('列出所有已保存账号')
    .action(async () => {
      const accounts = await listAccounts();
      const current = await getCurrentAccount();
      if (accounts.length === 0) {
        log.info('暂无账号。使用 login <name> 登录');
        return;
      }
      if (globalJson) {
        console.log(JSON.stringify({ accounts, current }, null, 2));
        return;
      }
      log.info(`共 ${accounts.length} 个账号（${C.green}*${C.reset} 标记当前账号）:`);
      for (const a of accounts) {
        const mark = a.name === current ? `${C.green}*${C.reset}` : ' ';
        const time = new Date(a.savedAt).toLocaleString('zh-CN', { hour12: false });
        const sessionTag = a.hasSessionid ? `${C.green}已登录${C.reset}` : `${C.gray}无sessionid${C.reset}`;
        log.info(`  ${mark} ${a.name.padEnd(20)} uid=${(a.uid || '?').padEnd(20)} [${sessionTag}] 保存于 ${time}`);
      }
    });

  /* --------------------------- use --------------------------- */
  program
    .command('use <name>')
    .description('切换当前账号（自动清除缓存）')
    .action(async (name: string) => {
      try {
        await setCurrentAccount(name);
        clearCache();
        catBox(`已切换账号: ${name}`);
      } catch (e) {
        log.error('切换账号失败', e);
      }
    });

  /* --------------------------- logout --------------------------- */
  program
    .command('logout <name>')
    .description('删除指定账号')
    .option('-f, --force', '跳过确认提示', false)
    .action(async (name: string, opts: { force: boolean }) => {
      if (!opts.force) {
        log.warn(`将删除账号 ${name}。如确认请加 -f 参数：logout ${name} -f`);
        return;
      }
      try {
        await deleteAccount(name);
        catBox(`已删除账号: ${name}`);
      } catch (e) {
        log.error('删除账号失败', e);
      }
    });

  /* --------------------------- whoami --------------------------- */
  program
    .command('whoami')
    .description('显示当前账号和登录态')
    .action(async () => {
      const current = await getCurrentAccount();
      if (!current) {
        log.info('当前未设置账号（将使用默认兜底）');
        return;
      }
      if (globalJson) {
        console.log(JSON.stringify({ current }, null, 2));
        return;
      }
      log.info(`当前账号: ${C.cyan}${current}${C.reset}`);
      try {
        const { path: statePath } = await resolveStorageState(undefined, current);
        const session = await loadFromStorageState(statePath);
        const uid = session.uid || '?';
        const hasSid = Boolean(session.cookies['sessionid']);
        log.info(`  uid_tt: ${uid}`);
        log.info(`  sessionid: ${hasSid ? `${C.green}有${C.reset}` : `${C.red}无${C.reset}`}`);
        log.info(`  保存于: ${new Date(session.savedAt).toLocaleString('zh-CN', { hour12: false })}`);
      } catch (e) {
        log.warn(`  读取账号信息失败: ${e}`);
      }
    });

  /* --------------------------- list --------------------------- */
  program
    .command('list')
    .description('列出所有会话（联系人）')
    .action(async () => {
      await run(async ({ env }) => {
        const contacts = await listContacts(env);
        const aliases = await loadAliases();
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
              c.nickname = `(uid:${c.uid.slice(-6)})`;
            }
          }
          log.info(`list: 成功获取 ${resolvedCount}/${secUidsToFetch.length} 个 nickname`);
        }
        for (const c of contacts) {
          if (aliases[c.uid]) c.nickname = aliases[c.uid];
        }
        _contactsCache = contacts; // 缓存
        const myUid = detectMyUid(contacts);
        output(contacts, (data) => {
          log.info(`共 ${C.bold}${data.length}${C.reset} 个会话`);
          if (myUid) log.info(`当前账号 UID: ${C.cyan}${myUid}${C.reset}`);
          console.log(divider());
          console.log(formatTable(
            ['#', '昵称', 'UID', '未读', '会话ID'],
            data.map((c, i) => [
              String(i + 1),
              c.nickname || '(未知)',
              c.uid || '-',
              c.unreadCount !== undefined ? (c.unreadCount > 0 ? `${C.brightRed}${c.unreadCount}${C.reset}` : '0') : '-',
              c.conversationId,
            ]),
          ));
          console.log(divider());
          log.info(`提示: 使用 rename --uid <uid> --name <昵称> 设置备注名`);
        });
      });
    });

  /* --------------------------- rename --------------------------- */
  program
    .command('rename')
    .description('为指定用户设置本地备注名')
    .requiredOption('--uid <uid>', '用户 UID')
    .requiredOption('--name <name>', '备注名')
    .action(async (opts: { uid: string; name: string }) => {
      const aliases = await loadAliases();
      aliases[opts.uid] = opts.name;
      await saveAliases(aliases);
      catBox(`备注已设置: ${opts.name}`);
    });

  /* --------------------------- cookie --------------------------- */
  program
    .command('cookie <string>')
    .description('直接使用 cookie 字符串登录（适用于从 APP 抓包的实时 cookie）')
    .action(async (cookieStr: string) => {
      try {
        // 测试 cookie 是否能解析
        const test = sessionFromCookieString(cookieStr);
        setCookie(cookieStr);
        const cookieCount = Object.keys(test.cookies).length;
        catBox(`已使用 cookie 字符串登录（${cookieCount} 个 cookie）`);
        log.info(`  uid_tt: ${test.uid || '?'}`);
        log.info(`  sessionid: ${test.cookies['sessionid'] ? `${C.green}有${C.reset}` : `${C.red}无${C.reset}`}`);
        log.info(`${C.gray}输入 list 验证登录状态${C.reset}`);
      } catch (e) {
        log.error(`cookie 解析失败: ${e}`);
      }
    });

  /* --------------------------- cookie-file --------------------------- */
  program
    .command('cookie-file <path>')
    .description('从文件读取 cookie 字符串登录（文件内容为纯 cookie 文本）')
    .action(async (filePath: string) => {
      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const cookieStr = raw.trim();
        if (!cookieStr) {
          log.error(`文件为空: ${filePath}`);
          return;
        }
        const test = sessionFromCookieString(cookieStr);
        setCookie(cookieStr);
        const cookieCount = Object.keys(test.cookies).length;
        catBox(`已从文件加载 cookie（${cookieCount} 个）`);
        log.info(`  文件: ${filePath}`);
        log.info(`  uid_tt: ${test.uid || '?'}`);
        log.info(`  sessionid: ${test.cookies['sessionid'] ? `${C.green}有${C.reset}` : `${C.red}无${C.reset}`}`);
        log.info(`${C.gray}输入 list 验证登录状态${C.reset}`);
      } catch (e) {
        log.error(`读取文件失败: ${filePath}`, e);
      }
    });

  /* --------------------------- send --------------------------- */
  program
    .command('send')
    .description('向指定用户发送文本消息')
    .option('-t, --text <text>', '消息内容（--dev 模式下可省略）')
    .option('--to <target>', '目标用户 uid 或昵称', 'TwT')
    .option('--dev', '开发模式：启动已登录浏览器抓包 /v1/message/send 请求（不实际发送）')
    .option('--out', '抓包结果保存到 data/capture/send/ 目录（与 --dev 配合使用）')
    .option('--native', '使用纯 Node.js 原生发送（需手动签名，可能失败）')
    .option('--show-browser', '显示浏览器窗口（默认无头）')
    .action(async (opts: { text?: string; to: string; dev?: boolean; out?: boolean; native?: boolean; showBrowser?: boolean }) => {
      // 开发抓包模式
      if (opts.dev) {
        log.info(`${C.brightYellow}[开发模式]${C.reset} 启动浏览器抓包 /v1/message/send 请求`);
        log.info(`${C.brightYellow}[开发模式]${C.reset} 忽略 --to 和 --text 参数，请在浏览器中手动发送`);
        log.info(`${C.brightYellow}[开发模式]${C.reset} 抓包结果${opts.out ? '保存到 data/capture/send/' : '仅打印到终端'}`);
        try {
          const statePath = await getStatePathForBrowser();
          const captured = await captureSendRequests({
            storageStatePath: statePath,
            headless: false,
          });
          if (captured.length === 0) {
            log.warn('未捕获到任何 /v1/message/send 请求');
          } else {
            log.info(`共捕获 ${captured.length} 个请求`);
            if (opts.out) {
              log.info(`抓包文件已保存到 ${C.cyan}data/capture/send/${C.reset}`);
            }
          }
        } catch (e) {
          log.error('抓包异常', e);
        }
        return;
      }

      // 正常发送模式：必须提供 --text
      if (!opts.text) {
        log.error('缺少必填参数: -t, --text <text>（或使用 --dev 进入抓包模式）');
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
          return;
        }
        log.info(`发送给: ${C.cyan}${target.nickname}${C.reset} (uid=${target.uid})`);
        log.info(`消息内容: ${opts.text}`);
        const cid = buildPrivateCid(myUid, target.uid);

        if (opts.native) {
          // 原生发送（纯 Node.js，需手动签名，可能因缺少 bd-ticket-guard 签名而失败）
          log.info(`${C.gray}使用原生发送模式（--native）${C.reset}`);
          const sign: SendSignContext = {
            conversationShortId: target.conversationShortId,
            conversationType: 1,
            ticket: target.ticket || '',
          };
          const result = await sendMessage(env, cid, opts.text, sign);
          output(result, (data) => {
            if (data.success) {
              catBox('发送成功');
              if (data.serverMsgId) log.info(`  serverMsgId: ${C.gray}${data.serverMsgId}${C.reset}`);
            } else {
              log.error(`发送失败: ${data.reason || '未知原因'}`);
            }
          });
        } else {
          // 浏览器发送（默认，自动签名）
          log.info(`${C.gray}使用浏览器发送模式（默认，--native 切换原生）${C.reset}`);
          const statePath = await getStatePathForBrowser();
          const sign: BrowserSendSign = {
            conversationShortId: target.conversationShortId,
            conversationType: 1,
            ticket: target.ticket || '',
          };
          const result = await sendViaBrowser(
            statePath,
            env,
            cid,
            opts.text,
            sign,
            !opts.showBrowser,
          );
          output(result, (data) => {
            if (data.success) {
              catBox('发送成功');
              if (data.serverMsgId) log.info(`  serverMsgId: ${C.gray}${data.serverMsgId}${C.reset}`);
            } else {
              log.error(`发送失败: ${data.reason || '未知原因'}`);
            }
          });
        }
      });
    });

  /* --------------------------- recall --------------------------- */
  program
    .command('recall')
    .description('撤回指定消息')
    .option('--to <target>', '目标用户', 'TwT')
    .option('--cid <conversationId>', '直接指定 conversationId')
    .option('--msg-id <serverMsgId>', '指定要撤回的 server_message_id')
    .action(async (opts: { to: string; cid?: string; msgId?: string }) => {
      await run(async ({ env }) => {
        const contacts = await getContacts(env);
        const aliases = await loadAliases();
        for (const c of contacts) {
          if (aliases[c.uid]) c.nickname = aliases[c.uid];
        }
        const myUid = detectMyUid(contacts);
        let conversationId: string;
        let conversationShortId: string;
        let targetLabel: string;
        if (opts.cid) {
          const c = contacts.find((x) => x.conversationId === opts.cid);
          if (!c || !c.conversationShortId) {
            log.error(`找不到会话: ${opts.cid}`);
            return;
          }
          conversationId = opts.cid;
          conversationShortId = c.conversationShortId;
          targetLabel = c.nickname || c.uid;
        } else {
          const target = await resolveTarget(env, opts.to, myUid, contacts);
          if (!target) {
            log.error(`找不到目标用户: ${opts.to}`);
            return;
          }
          conversationId = buildPrivateCid(myUid, target.uid);
          conversationShortId = target.conversationShortId;
          targetLabel = target.nickname;
        }
        log.info(`目标会话: ${targetLabel} cid=${conversationId} shortId=${conversationShortId}`);
        let serverMsgId = opts.msgId;
        if (!serverMsgId) {
          log.info(`未指定 --msg-id，拉取最近消息...`);
          const messages = await getHistory(env, conversationId, {
            direction: 3,
            limit: 20,
            conversationShortId,
            myUid,
          });
          const myMsg = messages.find((m) => m.isSelf);
          if (!myMsg || !myMsg.serverMsgId) {
            log.error(`未找到自己发送的消息（最近 ${messages.length} 条内）`);
            return;
          }
          serverMsgId = myMsg.serverMsgId;
          log.info(`找到最近一条自己发的消息: serverMsgId=${serverMsgId}`);
        }
        const result = await recallMessage(env, conversationId, serverMsgId, conversationShortId);
        output(result, (data) => {
          if (data.success) {
            catBox('撤回成功');
          } else {
            log.error(`撤回失败: ${data.reason || '未知原因'}`);
          }
        });
      });
    });

  /* --------------------------- send-image --------------------------- */
  program
    .command('send-image')
    .description('向指定用户发送图片消息')
    .requiredOption('-i, --image <path>', '图片文件路径')
    .option('--to <target>', '目标用户', 'TwT')
    .action(async (opts: { image: string; to: string }) => {
      await run(async ({ env }) => {
        let imageBytes: Buffer;
        try {
          imageBytes = await fs.readFile(opts.image);
        } catch (e) {
          log.error(`读取图片失败: ${opts.image}`, e);
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
          return;
        }
        log.info(`发送给: ${C.cyan}${target.nickname}${C.reset} (uid=${target.uid})`);
        const commit = await uploadImage(env, imageBytes, myUid);
        if (!commit) {
          log.error(`上传图片失败，终止发送`);
          return;
        }
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
            catBox('图片发送成功');
            if (data.serverMsgId) log.info(`  serverMsgId: ${C.gray}${data.serverMsgId}${C.reset}`);
          } else {
            log.error(`发送失败: ${data.reason || '未知原因'}`);
          }
        });
      });
    });

  /* --------------------------- history --------------------------- */
  program
    .command('history')
    .description('获取指定会话的聊天记录')
    .option('--to <target>', '目标用户', 'TwT')
    .option('--cid <conversationId>', '直接指定 conversationId')
    .option('--limit <count>', '拉取条数', '30')
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
            return;
          }
          cid = buildPrivateCid(myUid, target.uid);
          shortId = target.conversationShortId;
          nickname = target.nickname;
        } else {
          const c = contacts.find((x) => x.conversationId === cid);
          if (c) {
            shortId = c.conversationShortId;
            nickname = c.nickname;
          } else {
            log.error(`未找到会话: ${cid}`);
            return;
          }
        }
        if (!shortId) {
          log.error(`无法获取 conversation_short_id`);
          return;
        }
        const limit = parseInt(opts.limit, 10) || 30;
        log.info(`会话: ${C.cyan}${nickname}${C.reset}  cid=${cid}  shortId=${shortId}  limit=${limit}`);

        let messages: MessageItem[];
        if (limit > 50) {
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

        // 图片解密
        const decodedDir = path.join(DATA_DIR, 'decoded');
        await fs.mkdir(decodedDir, { recursive: true });

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

        const plainImages = messages.filter((m) => m.category === 'image' && !m.isEncryptedImage && m.imageSkey);
        if (plainImages.length > 0) {
          const withUrl = plainImages.filter((m) => m.stickerUrl);
          const withoutUrl = plainImages.filter((m) => !m.stickerUrl);
          log.info(`检测到 ${plainImages.length} 条普通图片（有URL ${withUrl.length} / 无URL ${withoutUrl.length}），解密下载...`);
          let ok = 0;
          for (const m of withUrl) {
            const oid = m.contentJson?.match(/"oid"\s*:\s*"([^"]+)"/)?.[1] || 'douyin_image';
            if (await downloadAndDecrypt(m.stickerUrl!, m.imageSkey!, oid)) ok++;
          }
          for (const m of withoutUrl) {
            const oid = m.contentJson?.match(/"oid"\s*:\s*"([^"]+)"/)?.[1];
            if (!oid) { log.warn('  无 oid，跳过'); continue; }
            const urls = await buildImageUrl(env, oid);
            if (urls.length === 0) { log.warn(`  batch_build_image 失败 oid=${oid}`); continue; }
            m.stickerUrl = urls[0];
            m.text = '[图片]';
            if (await downloadAndDecrypt(urls[0], m.imageSkey!, oid)) ok++;
          }
          log.info(`普通图片解密完成: ${ok}/${plainImages.length} 成功`);
        }

        const encryptedMsgs = messages.filter((m) => m.isEncryptedImage && m.serverMsgId);
        if (encryptedMsgs.length > 0) {
          log.info(`检测到 ${encryptedMsgs.length} 条加密图片，尝试解密...`);
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
          log.info(`加密图片解密完成: 成功 ${decryptedCount} | 已被查看过 ${alreadyReadCount} | 已保存 ${savedCount}`);
        }

        output(messages, (data) => {
          log.info(`共 ${C.bold}${data.length}${C.reset} 条消息`);
          console.log(divider());
          for (const m of data) {
            console.log(formatMessageLine(m));
          }
          console.log(divider());
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
            `${C.magenta}统计${C.reset}: 文本 ${stats.text} | 分享视频 ${stats.video_share} | AI回复 ${stats.ai_text} | 系统提示 ${stats.system_tip} | 表情 ${stats.sticker} | 图片 ${stats.image} | 撤回 ${stats.recall} | 其他 ${stats.other}`,
          );
        });
      });
    });

  /* --------------------------- send-sticker --------------------------- */
  program
    .command('send-sticker')
    .description('发送表情贴纸消息')
    .option('-s, --sticker <path>', 'sticker 信息 JSON 文件路径')
    .option('-m, --from-msg <serverMsgId>', '从历史 sticker 消息中提取信息')
    .option('--to <target>', '目标用户', 'TwT')
    .action(async (opts: { sticker?: string; fromMsg?: string; to: string }) => {
      if (!opts.sticker && !opts.fromMsg) {
        log.error(`必须指定 --sticker <path> 或 --from-msg <serverMsgId>`);
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
          return;
        }
        log.info(`发送给: ${C.cyan}${target.nickname}${C.reset} (uid=${target.uid})`);
        let stickerInfo: StickerSendInfo;
        if (opts.fromMsg) {
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
        } else {
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
            return;
          }
        }
        if (!stickerInfo.imageId || !stickerInfo.uri || stickerInfo.urlList.length === 0) {
          log.error(`sticker 信息不完整`);
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
            catBox('表情发送成功');
          } else {
            log.error(`发送失败: ${data.reason || '未知原因'}`);
          }
        });
      });
    });

  /* --------------------------- reply --------------------------- */
  program
    .command('reply')
    .description('引用回复消息')
    .requiredOption('-t, --text <text>', '回复内容')
    .requiredOption('-r, --ref <serverMsgId>', '被引用消息的 server_message_id')
    .option('--to <target>', '目标用户', 'TwT')
    .option('--native', '使用纯 Node.js 原生发送（需手动签名，可能失败）')
    .option('--show-browser', '显示浏览器窗口（默认无头模式）')
    .action(async (opts: { text: string; ref: string; to: string; native?: boolean; showBrowser?: boolean }) => {
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
          return;
        }
        const cid = buildPrivateCid(myUid, target.uid);
        const shortId = target.conversationShortId;
        log.info(`查找被引用消息: serverMsgId=${opts.ref}`);
        const messages = await getHistory(env, cid, {
          direction: 3,
          limit: 50,
          conversationShortId: shortId,
          myUid,
        });
        const refMsg = messages.find((m) => m.serverMsgId === opts.ref);
        if (!refMsg) {
          log.error(`未找到 serverMsgId=${opts.ref} 的消息`);
          return;
        }
        log.info(`被引用消息: [${refMsg.category}] ${refMsg.text?.slice(0, 30)}`);
        const ref: QuoteReplyRef = {
          serverMsgId: refMsg.serverMsgId!,
          refmsgType: refMsg.messageType,
          refmsgUid: refMsg.senderId,
          refmsgSecUid: '',
          refmsgNickname: refMsg.senderLabel === '我' ? '我' : '对方',
          refmsgShortText: refMsg.text || '',
          refmsgContent: refMsg.contentJson || '{}',
        };
        if (opts.native) {
          // 原生发送（纯 Node.js，需手动签名，可能因缺少 bd-ticket-guard 签名而失败）
          log.info(`${C.gray}使用原生发送模式（--native）${C.reset}`);
          const sign: SendSignContext = {
            conversationShortId: shortId,
            conversationType: 1,
            ticket: target.ticket || '',
          };
          const result = await sendQuoteReply(env, cid, opts.text, ref, sign);
          output(result, (data) => {
            if (data.success) {
              catBox('回复成功');
            } else {
              log.error(`回复失败: ${data.reason || '未知原因'}`);
            }
          });
        } else {
          // 浏览器发送（默认，自动签名）
          log.info(`${C.gray}使用浏览器发送模式（默认，--native 切换原生）${C.reset}`);
          const statePath = await getStatePathForBrowser();
          const sign: BrowserSendSign = {
            conversationShortId: shortId,
            conversationType: 1,
            ticket: target.ticket || '',
          };
          const result = await sendQuoteReplyViaBrowser(
            statePath,
            env,
            cid,
            opts.text,
            ref,
            sign,
            !opts.showBrowser,
          );
          output(result, (data) => {
            if (data.success) {
              catBox('回复成功');
              if (data.serverMsgId) log.info(`  serverMsgId: ${C.gray}${data.serverMsgId}${C.reset}`);
            } else {
              log.error(`回复失败: ${data.reason || '未知原因'}`);
            }
          });
        }
      });
    });

  /* --------------------------- collect-sticker --------------------------- */
  program
    .command('collect-sticker')
    .description('收藏表情贴纸')
    .requiredOption('-m, --msg-id <serverMsgId>', 'sticker 消息的 server_message_id')
    .option('--to <target>', '目标用户', 'TwT')
    .option('--action <n>', '1=收藏, 0=取消', '1')
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
          return;
        }
        const cid = buildPrivateCid(myUid, target.uid);
        const shortId = target.conversationShortId;
        log.info(`查找 sticker 消息: serverMsgId=${opts.msgId}`);
        const messages = await getHistory(env, cid, {
          direction: 3,
          limit: 50,
          conversationShortId: shortId,
          myUid,
        });
        const stickerMsg = messages.find((m) => m.serverMsgId === opts.msgId);
        if (!stickerMsg || stickerMsg.category !== 'sticker') {
          log.error(`未找到 sticker 消息`);
          return;
        }
        const content = JSON.parse(stickerMsg.contentJson || '{}');
        const stickerId = String(content.image_id);
        const stickerUri = content.url?.uri || '';
        const stickerUrl = content.url?.url_list?.[0] || stickerMsg.stickerUrl || '';
        const resourceId = String(content.package_id);
        const stickerType = content.resource_type ?? 1;
        const action = parseInt(opts.action, 10) || 1;
        const ok = await collectSticker(
          env,
          { stickerId, stickerUri, stickerUrl, resourceId, stickerType },
          action,
        );
        if (ok) {
          catBox(action === 1 ? '收藏成功' : '取消收藏成功');
        } else {
          log.error(`操作失败`);
        }
      });
    });

  /* --------------------------- video --------------------------- */
  program
    .command('video')
    .description('查看视频分享详情')
    .option('--to <target>', '目标用户', 'TwT')
    .option('--aweme-id <id>', '视频 aweme_id')
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
            log.error(`未找到视频分享消息`);
            return;
          }
          const content = JSON.parse(videoMsg.contentJson || '{}');
          const id = String(content.itemId || content.aweme_id || content.item_id || '');
          if (!id) {
            log.error(`消息中未找到 aweme_id`);
            return;
          }
          awemeIds = [id];
        } else {
          log.error(`必须指定 --aweme-id 或 --msg-id`);
          return;
        }
        log.info(`查询视频详情: awemeIds=${awemeIds.join(',')}`);
        const videos = await getVideoDetail(env, awemeIds, shortId);
        if (videos.length === 0) {
          log.error(`查询失败`);
          return;
        }
        output(videos, (data) => {
          for (const v of data) {
            console.log(divider());
            log.info(`视频 ID: ${C.cyan}${v.awemeId}${C.reset}`);
            if (v.desc) log.info(`标题: ${v.desc}`);
            if (v.authorNickname) log.info(`作者: ${v.authorNickname}`);
            if (v.duration) log.info(`时长: ${v.duration}ms`);
            if (v.diggCount !== undefined) log.info(`点赞: ${C.brightRed}${v.diggCount}${C.reset}`);
            if (v.commentCount !== undefined) log.info(`评论: ${v.commentCount}`);
            if (v.shareCount !== undefined) log.info(`分享: ${v.shareCount}`);
            if (v.coverUrl) log.info(`封面: ${C.gray}${v.coverUrl}${C.reset}`);
            if (v.playUrl) log.info(`播放: ${C.gray}${v.playUrl}${C.reset}`);
          }
          console.log(divider());
        });
      });
    });

  /* --------------------------- ai (白名单管理) --------------------------- */
  program
    .command('ai')
    .description('AI 自动回复白名单管理')
    .option('--add <uid>', '添加用户到白名单')
    .option('--del <uid>', '从白名单移除用户')
    .option('--list', '查看当前白名单', false)
    .option('--refresh', '从本地文件重新加载白名单', false)
    .action(async (opts: { add?: string; del?: string; list: boolean; refresh: boolean }) => {
      if (opts.add) {
        const ok = await addWhitelist(opts.add);
        if (ok) log.info(`${C.brightGreen}[ai]${C.reset} 已添加白名单: ${C.cyan}${opts.add}${C.reset}`);
        else log.error(`[ai] 添加失败: ${opts.add}`);
        return;
      }
      if (opts.del) {
        const ok = await removeWhitelist(opts.del);
        if (ok) log.info(`${C.brightGreen}[ai]${C.reset} 已移除白名单: ${C.cyan}${opts.del}${C.reset}`);
        else log.error(`[ai] 移除失败: ${opts.del}`);
        return;
      }
      if (opts.refresh) {
        const list = await refreshWhitelist();
        log.info(`${C.brightGreen}[ai]${C.reset} 白名单已加载: ${list.length} 个用户`);
        return;
      }
      // 默认：列出白名单（从本地文件加载确保最新）
      const list = await refreshWhitelist();
      if (list.length === 0) {
        log.info(`${C.yellow}[ai]${C.reset} 白名单为空，使用 ${C.cyan}ai --add <uid>${C.reset} 添加用户`);
        log.info(`提示: 先用 ${C.cyan}list${C.reset} 查看联系人 UID`);
      } else {
        log.info(`${C.brightGreen}[ai]${C.reset} 白名单 ${list.length} 个用户:`);
        for (const uid of list) console.log(`  ${C.cyan}${uid}${C.reset}`);
        log.info(`使用 ${C.cyan}watch --ai${C.reset} 开始自动回复`);
      }
    });

  /* --------------------------- watch --------------------------- */
  program
    .command('watch')
    .description('实时监控新消息推送（Ctrl+C 返回 REPL）')
    .option('--access-key <key>', '手动指定 access_key')
    .option('--device-id <uid>', '设备ID')
    .option('--to <target>', '仅监控指定会话')
    .option('--raw', '显示原始帧', false)
    .option('--ai', '开启 AI 自动回复（仅白名单内用户）', false)
    .action(async (opts: { accessKey?: string; deviceId?: string; to?: string; raw: boolean; ai: boolean }) => {
      await run(async ({ env, session }) => {
        const contacts = await getContacts(env);
        const aliases = await loadAliases();
        for (const c of contacts) {
          if (aliases[c.uid]) c.nickname = aliases[c.uid];
        }
        const myUid = detectMyUid(contacts);
        if (!myUid) {
          log.error('无法识别当前账号 UID');
          return;
        }
        log.info(`当前账号 UID: ${C.cyan}${myUid}${C.reset}`);
        let targetCid: string | undefined;
        if (opts.to) {
          const target = await resolveTarget(env, opts.to, myUid, contacts);
          if (!target) {
            log.error(`找不到目标用户: ${opts.to}`);
            return;
          }
          targetCid = buildPrivateCid(myUid, target.uid);
          log.info(`仅监控会话: ${target.nickname} cid=${targetCid}`);
        }
        const cidToNickname = new Map<string, string>();
        for (const c of contacts) {
          cidToNickname.set(c.conversationId, c.nickname);
        }
        let accessKey = opts.accessKey;
        let deviceId = opts.deviceId || myUid;
        if (!accessKey) {
          log.info('未指定 --access-key，启动浏览器自动提取...');
          try {
            const statePath = await getStatePathForBrowser();
            const extracted = await extractWsAccessKey(statePath);
            accessKey = extracted.accessKey;
            if (!opts.deviceId) deviceId = extracted.deviceId;
            log.info(`提取成功: access_key=${accessKey.slice(0, 8)}... device_id=${deviceId}`);
          } catch (e) {
            log.error('自动提取 access_key 失败', e);
            return;
          }
        }
        const seenMsgIds = new Set<string>();
        log.info(`${C.cyan}[watch]${C.reset} 开始监听（Ctrl+C 返回 REPL）`);
        let aiBrowserSender: BrowserSender | null = null;
        if (opts.ai) {
          log.info(`${C.brightMagenta}[watch]${C.reset} AI 自动回复已开启，正在加载本地白名单...`);
          await refreshWhitelist();
          log.info(`${C.brightMagenta}[watch]${C.reset} 仅白名单内用户会收到 AI 回复，其他消息只记录不回复`);
          // 启动浏览器发送器（用于 AI 回复时自动签名）
          log.info(`${C.brightMagenta}[watch]${C.reset} 正在启动浏览器发送器（自动签名）...`);
          try {
            const statePath = await getStatePathForBrowser();
            aiBrowserSender = new BrowserSender(statePath, true);
            await aiBrowserSender.launch();
            setBrowserSender(aiBrowserSender);
          } catch (e) {
            log.warn(`[watch] 浏览器发送器启动失败，AI 回复将使用原生发送（可能失败）: ${e}`);
            aiBrowserSender = null;
          }
          // 启动时检查白名单用户的未读消息（处理离线期间错过的消息）
          log.info(`${C.brightMagenta}[watch]${C.reset} 正在检查未读消息...`);
          try {
            // 加载持久化回复记录（重启后仍能记住已回复的消息）
            const { loadReplyLog } = await import('./auth/reply-log.js');
            await loadReplyLog();
            const unreadCount = await processUnreadMessages(myUid, contacts, env);
            if (unreadCount > 0) {
              log.info(`${C.brightMagenta}[watch]${C.reset} 未读检查完成，已回复 ${unreadCount} 条未读消息`);
            } else {
              log.info(`${C.brightMagenta}[watch]${C.reset} 未读检查完成，无未读消息需回复`);
            }
          } catch (e) {
            log.warn(`[watch] 未读检查异常: ${e}`);
          }
        }
        console.log(divider());

        const conn = connectFrontier({
          accessKey,
          deviceId,
          cookie: session.cookie,
          onOpen: () => {
            log.info(`${C.cyan}[watch]${C.reset} 已连接，等待消息推送...`);
          },
          onFrame: (frame) => handleFrame(frame),
          onReconnect: (attempt, delayMs) => {
            log.warn(`[watch] 连接断开，${delayMs}ms 后第 ${attempt} 次重连...`);
          },
          onClose: (code, reason) => {
            log.warn(`[watch] 连接关闭 code=${code} reason=${reason}`);
          },
          onError: (err) => {
            log.error('[watch] WebSocket 错误', err);
          },
        });
        // watch 模式下 Ctrl+C 关闭连接返回 REPL（而非退出整个进程）
        const onSigInt = async () => {
          console.log();
          log.info(`${C.yellow}[watch]${C.reset} 正在关闭连接...`);
          conn.close();
          // 关闭浏览器发送器
          if (aiBrowserSender) {
            setBrowserSender(null);
            await aiBrowserSender.close();
            aiBrowserSender = null;
          }
          process.removeListener('SIGINT', onSigInt);
        };
        process.on('SIGINT', onSigInt);

        function handleFrame(frame: FrontierFrame): void {
          if (opts.raw) {
            log.info(`[raw] msgId=${frame.msgId} ts=${frame.serverTimestamp}`);
            return;
          }
          if (!frame.payload) return;
          const p = frame.payload;
          if (p.msgType !== 500) {
            if (p.conversationId) {
              const name = cidToNickname.get(p.conversationId) || '(未知会话)';
              log.info(`[通知] type=${p.msgType} 会话=${name}`);
            }
            return;
          }
          const cid = p.conversationId;
          if (!cid) return;
          if (targetCid && cid !== targetCid) return;
          if (frame.msgId && seenMsgIds.has(frame.msgId)) return;
          if (frame.msgId) seenMsgIds.add(frame.msgId);
          if (seenMsgIds.size > 200) {
            const first = seenMsgIds.values().next().value;
            if (first) seenMsgIds.delete(first);
          }
          const nickname = cidToNickname.get(cid) || '(未知会话)';
          const text = p.text || '(非文本消息)';
          // WS 推送的方向判断不可靠（direction 字段与实际相反，senderUid 解析不到），
          // 只把推送当通知用，显示用推送文本（仅供查看），AI 触发改用 history 拉取权威判断
          log.info(`${C.brightGreen}[新消息]${C.reset} ${nickname} | 推送: ${text}`);
          log.debug(`[watch调试] direction=${p.direction} msgType=${p.msgType} cid=${cid} myUid=${myUid}`);
          // AI 自动回复：仅 --ai 开启时，收到推送就触发 history 拉取
          // 由 handleIncomingMessageViaHistory 用 history 的 isSelf/category 做权威判断：
          //   - 跳过自己发的、撤回的、非文本的
          //   - 只对白名单内用户最新的对方文本消息回复
          //   - 用 serverMsgId 去重，允许相同文本内容（用户可重复发挑衅 AI）
          if (opts.ai) {
            handleIncomingMessageViaHistory(cid, myUid, contacts, env).catch((e) => {
              log.error(`[AI回复] 异常: ${e}`);
            });
          }
        }
      });
    });

  /* --------------------------- profile --------------------------- */
  program
    .command('profile')
    .description('获取当前账号主页信息')
    .action(async () => {
      await run(async ({ env }) => {
        const { getSelfProfile } = await import('./commands/profile.js');
        const profile = await getSelfProfile(env);
        if (globalJson) {
          console.log(JSON.stringify(profile, null, 2));
          return;
        }
        console.log(C.cyan + '═'.repeat(60) + C.reset);
        log.info(`  昵称: ${C.bold}${profile.nickname}${C.reset}`);
        log.info(`  抖音号: ${profile.uniqueId || '(未设置)'}`);
        log.info(`  UID: ${profile.uid}`);
        log.info(`  sec_uid: ${C.gray}${profile.secUid}${C.reset}`);
        log.info(`  简介: ${profile.signature || '(无)'}`);
        log.info(`  关注: ${profile.followingCount ?? '?'}`);
        log.info(`  粉丝: ${C.brightMagenta}${profile.followerCount ?? '?'}${C.reset}`);
        log.info(`  获赞: ${profile.totalFavorited ?? '?'}`);
        log.info(`  作品: ${profile.awemeCount ?? '?'}`);
        if (profile.country) log.info(`  地区: ${profile.country}`);
        if (profile.bindPhone) log.info(`  绑定手机: ${profile.bindPhone}`);
        if (profile.avatarUrl) log.info(`  头像: ${C.gray}${profile.avatarUrl}${C.reset}`);
        console.log(C.cyan + '═'.repeat(60) + C.reset);
      });
    });

  /* --------------------------- edit-profile --------------------------- */
  program
    .command('edit-profile')
    .description('修改个人资料')
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
          const statePath = await getStatePathForBrowser();
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
          catBox(result.message || '资料修改成功');
        } else {
          log.error(`修改失败: ${result.message}`);
        }
      });
    });

  /* --------------------------- notices --------------------------- */
  program
    .command('notices')
    .description('获取互动消息列表')
    .option('--count <n>', '每页数量', '20')
    .option('--max <n>', '最大拉取条数', '50')
    .action(async (opts: { count: string; max: string }) => {
      await run(async ({ env }) => {
        const { getNotices } = await import('./commands/profile.js');
        const count = parseInt(opts.count, 10);
        const maxItems = parseInt(opts.max, 10);
        const items: Awaited<ReturnType<typeof getNotices>>['items'] = [];
        const seenNids = new Set<string>();
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
          const oldest = page.items[page.items.length - 1]?.createTime ?? 0;
          if (oldest <= 0 || added === 0) {
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
        log.info(`共 ${C.bold}${items.length}${C.reset} 条互动消息${hasMore ? `${C.gray}（还有更多）${C.reset}` : ''}`);
        console.log(divider());
        for (const n of items) {
          const time = new Date(n.createTime * 1000).toLocaleString('zh-CN', { hour12: false });
          const typeLabel = noticeTypeLabel(n.type);
          const from = n.fromNickname || '?';
          const label = n.labelText ? ` ${n.labelText}` : '';
          const desc = n.awemeDesc ? `《${truncate(n.awemeDesc, 30)}》` : '';
          const comment = n.commentText ? ` 评论:"${truncate(n.commentText, 40)}"` : '';
          const merge = n.mergeCount && n.mergeCount > 1 ? ` (×${n.mergeCount})` : '';
          const readTag = n.hasRead ? '' : `${C.brightRed} [未读]${C.reset}`;
          log.info(`[${C.gray}${time}${C.reset}] [${C.brightBlue}${typeLabel}${C.reset}] ${from}${merge}${label}${desc}${comment}${readTag}`);
        }
        console.log(divider());
      });
    });

  /* --------------------------- noticedetail --------------------------- */
  program
    .command('noticedetail')
    .description('查询单条通知详情')
    .requiredOption('--nid <id>', '通知 ID')
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
        console.log(divider());
        log.info(`时间: ${time}`);
        log.info(`类型: ${typeLabel} (type=${n.type})`);
        log.info('已读: ' + (n.hasRead ? `${C.green}是${C.reset}` : `${C.yellow}否${C.reset}`));
        if (n.fromNickname) log.info(`触发用户: ${n.fromNickname}`);
        if (n.awemeId) log.info(`关联视频: aweme_id=${n.awemeId}`);
        if (n.commentId) log.info(`关联评论: comment_id=${n.commentId}`);
        if (n.schemaUrl) log.info(`跳转链接: ${C.gray}${n.schemaUrl}${C.reset}`);
        console.log(divider());
      });
    });

  /* --------------------------- awemedetail --------------------------- */
  program
    .command('awemedetail')
    .description('查询单个视频详情')
    .requiredOption('--aweme-id <id>', '视频 aweme_id')
    .option('--ticket-guard-client-data <v>', 'bd-ticket-guard-client-data 头值')
    .option('--ticket-guard-ree-public-key <v>', 'bd-ticket-guard-ree-public-key 头值')
    .action(async (opts: {
      awemeId: string;
      ticketGuardClientData?: string;
      ticketGuardReePublicKey?: string;
    }) => {
      await run(async ({ env }) => {
        const ticketGuard: TicketGuardHeaders | undefined = opts.ticketGuardClientData
          ? { clientData: opts.ticketGuardClientData, reePublicKey: opts.ticketGuardReePublicKey }
          : undefined;
        const detail = await getAwemeDetail(env, opts.awemeId, ticketGuard);
        if (!detail) {
          log.error(`查询失败: aweme_id=${opts.awemeId}`);
          return;
        }
        if (globalJson) {
          console.log(JSON.stringify(detail, null, 2));
          return;
        }
        log.info(`视频详情: aweme_id=${C.cyan}${detail.awemeId}${C.reset}`);
        console.log(divider());
        if (detail.desc) log.info(`标题: ${detail.desc}`);
        if (detail.authorNickname) log.info(`作者: ${detail.authorNickname}`);
        if (detail.duration) log.info(`时长: ${detail.duration}ms`);
        if (detail.diggCount !== undefined) log.info(`点赞: ${C.brightRed}${detail.diggCount}${C.reset}`);
        if (detail.commentCount !== undefined) log.info(`评论: ${detail.commentCount}`);
        if (detail.shareCount !== undefined) log.info(`分享: ${detail.shareCount}`);
        if (detail.coverUrl) log.info(`封面: ${C.gray}${detail.coverUrl}${C.reset}`);
        if (detail.playUrl) log.info(`播放: ${C.gray}${detail.playUrl}${C.reset}`);
        console.log(divider());
      });
    });

  /* --------------------------- comments --------------------------- */
  program
    .command('comments')
    .description('获取视频评论列表')
    .requiredOption('--aweme-id <id>', '视频 aweme_id')
    .option('--cursor <n>', '分页游标', '0')
    .option('--count <n>', '每页数量', '10')
    .option('--max <n>', '最大拉取条数', '30')
    .option('--ticket-guard-client-data <v>', 'bd-ticket-guard-client-data 头值')
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
          ? { clientData: opts.ticketGuardClientData, reePublicKey: opts.ticketGuardReePublicKey }
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
        log.info(`共 ${Math.min(all.length, maxItems)} 条评论${hasMore ? `（下一页 cursor=${cursor}）` : ''}`);
        console.log(divider());
        for (const c of all.slice(0, maxItems)) {
          const time = new Date(c.createTime * 1000).toLocaleString('zh-CN', { hour12: false });
          const hot = c.isHot ? `${C.brightRed}[热]${C.reset}` : '';
          const ip = c.ipLabel ? ` ${C.gray}[${c.ipLabel}]${C.reset}` : '';
          log.info(`[${time}] ${c.userNickname}${ip}${hot}: ${c.text}`);
          log.info(`  cid=${C.gray}${c.commentId}${C.reset} 点赞=${c.diggCount} 回复=${c.replyCount}`);
        }
        console.log(divider());
      });
    });

  /* --------------------------- comment --------------------------- */
  program
    .command('comment')
    .description('发布评论或回复评论')
    .requiredOption('--aweme-id <id>', '目标视频 aweme_id')
    .requiredOption('--text <content>', '评论内容')
    .option('--reply-id <cid>', '被回复评论 cid')
    .option('--at-uid <uid>', '@用户 uid')
    .option('--at-sec-uid <sec_uid>', '@用户 sec_uid')
    .option('--ticket-guard-client-data <v>', 'bd-ticket-guard-client-data 头值')
    .option('--ticket-guard-ree-public-key <v>', 'bd-ticket-guard-ree-public-key 头值')
    .option('--tt-session-dtrait <v>', 'x-tt-session-dtrait 头值')
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
        let ticketGuard: TicketGuardHeaders;
        if (opts.ticketGuardClientData && opts.ticketGuardReePublicKey && opts.ttSessionDtrait) {
          ticketGuard = {
            clientData: opts.ticketGuardClientData,
            reePublicKey: opts.ticketGuardReePublicKey,
            sessionDtrait: opts.ttSessionDtrait,
          };
          log.info('comment: 使用 CLI 手动指定的 ticket-guard 三头');
        } else {
          let cfg = await loadOrExtractTicketGuard(false);
          if (!cfg) {
            log.info('comment: 未找到 ticket-guard 配置，自动获取...');
            const statePath = await getStatePathForBrowser();
            const autoCfg = await autoExtractTicketGuard(statePath, { headless: true });
            if (autoCfg) {
              await saveTicketGuard(autoCfg);
              cfg = autoCfg;
            } else {
              log.error('comment: 自动获取三头失败');
              return;
            }
          }
          if (isTicketGuardExpired(cfg)) {
            log.warn(`comment: ticket-guard 可能已过期`);
          }
          ticketGuard = {
            clientData: cfg.clientData,
            reePublicKey: cfg.reePublicKey,
            sessionDtrait: cfg.sessionDtrait,
          };
        }
        let textExtra: Array<{ user_id: string; sec_uid: string; type: number; start: number; end: number }> = [];
        if (opts.atUid && opts.atSecUid) {
          const uids = opts.atUid.split(',').map((s) => s.trim()).filter(Boolean);
          const secUids = opts.atSecUid.split(',').map((s) => s.trim()).filter(Boolean);
          let searchStart = 0;
          for (let i = 0; i < uids.length; i++) {
            const atText = `@${i + 1}`;
            const idx = opts.text.indexOf(atText, searchStart);
            const start = idx >= 0 ? idx : 0;
            const end = idx >= 0 ? idx + atText.length : 0;
            textExtra.push({ user_id: uids[i], sec_uid: secUids[i], type: 0, start, end });
            if (idx >= 0) searchStart = end;
          }
        }
        const result = await publishComment(env, {
          awemeId: opts.awemeId,
          text: opts.text,
          replyId: opts.replyId,
          textExtra,
        }, ticketGuard);
        if (!result.success) {
          log.error(`评论发布失败`);
          return;
        }
        catBox('评论发布成功');
        log.info(`  cid: ${C.gray}${result.commentId}${C.reset}`);
      });
    });

  /* --------------------------- ticket-guard --------------------------- */
  program
    .command('ticket-guard')
    .description('管理 bd-ticket-guard 签名头')
    .option('--auto', '启动无头浏览器自动获取')
    .option('--from-capture', '从抓包数据提取')
    .option('--client-data <v>', '手动指定 client-data')
    .option('--ree-public-key <v>', '手动指定 ree-public-key')
    .option('--session-dtrait <v>', '手动指定 session-dtrait')
    .option('--show', '显示当前配置')
    .action(async (opts: {
      auto?: boolean;
      fromCapture?: boolean;
      clientData?: string;
      reePublicKey?: string;
      sessionDtrait?: string;
      show?: boolean;
    }) => {
      if (opts.show) {
        const cfg = await loadTicketGuard();
        if (!cfg) {
          log.info('当前无已保存的 ticket-guard 配置');
          return;
        }
        if (globalJson) {
          console.log(JSON.stringify(cfg, null, 2));
          return;
        }
        console.log(C.cyan + '═'.repeat(60) + C.reset);
        log.info(`来源: ${cfg.capturedFrom}`);
        log.info(`抓包时间: ${new Date(cfg.capturedAt).toLocaleString('zh-CN', { hour12: false })}`);
        const expired = isTicketGuardExpired(cfg);
        log.info(`状态: ${expired ? `${C.yellow}可能已过期${C.reset}` : `${C.green}有效${C.reset}`}`);
        console.log(C.cyan + '─'.repeat(60) + C.reset);
        log.info(`clientData (${cfg.clientData.length} chars): ${C.gray}${cfg.clientData.slice(0, 80)}...${C.reset}`);
        log.info(`reePublicKey (${cfg.reePublicKey.length} chars): ${C.gray}${cfg.reePublicKey}${C.reset}`);
        log.info(`sessionDtrait (${cfg.sessionDtrait.length} chars): ${C.gray}${cfg.sessionDtrait.slice(0, 80)}...${C.reset}`);
        console.log(C.cyan + '═'.repeat(60) + C.reset);
        return;
      }
      if (opts.auto) {
        const statePath = await getStatePathForBrowser();
        const extracted = await autoExtractTicketGuard(statePath, { headless: true });
        if (!extracted) {
          log.error('浏览器自动获取三头失败');
          return;
        }
        await saveTicketGuard(extracted);
        catBox('ticket-guard 三头自动获取成功');
        return;
      }
      if (opts.fromCapture) {
        const extracted = await extractTicketGuardFromCapture();
        if (!extracted) {
          log.error('从抓包数据提取失败');
          return;
        }
        await saveTicketGuard(extracted);
        catBox('ticket-guard 三头提取成功');
        return;
      }
      if (opts.clientData && opts.reePublicKey && opts.sessionDtrait) {
        const cfg: TicketGuardConfig = {
          clientData: opts.clientData,
          reePublicKey: opts.reePublicKey,
          sessionDtrait: opts.sessionDtrait,
          capturedAt: Date.now(),
          capturedFrom: 'manual',
        };
        await saveTicketGuard(cfg);
        catBox('ticket-guard 三头手动导入成功');
        return;
      }
      log.info('用法:');
      log.info('  ticket-guard --auto                 自动获取（推荐）');
      log.info('  ticket-guard --from-capture          从抓包数据提取');
      log.info('  ticket-guard --show                  显示当前配置');
      log.info('  ticket-guard --client-data <v> --ree-public-key <v> --session-dtrait <v>  手动导入');
    });

  return program;
}

// ============================ REPL 实现 ============================

/** 解析输入行，支持引号 */
function parseArgs(line: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === quoteChar) {
        inQuote = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

/** 加载并打印 MACT.txt 小猫 ASCII 艺术 */
async function loadAndPrintCat(): Promise<void> {
  try {
    const art = await fs.readFile(MACT_FILE, 'utf-8');
    // 逐行着色：交替使用青色和品红色，营造渐变效果
    const lines = art.split('\n');
    const colors = [C.cyan, C.brightCyan, C.brightBlue, C.brightMagenta, C.magenta];
    for (let i = 0; i < lines.length; i++) {
      const color = colors[i % colors.length];
      process.stdout.write(color + lines[i] + C.reset + '\n');
    }
  } catch {
    // 文件不存在时静默跳过
  }
}

/** 打印欢迎信息 */
function printWelcome(): void {
  console.log();
  console.log(C.brightMagenta + C.bold + '  ╔══════════════════════════════════════════════════╗' + C.reset);
  console.log(C.brightMagenta + C.bold + '  ║         SPRR V2 - 交互式 REPL 模式               ║' + C.reset);
  console.log(C.brightMagenta + C.bold + '  ╚══════════════════════════════════════════════════╝' + C.reset);
  console.log();
  console.log(C.gray + '  输入 help 查看可用命令，输入 exit 退出' + C.reset);
  console.log(C.gray + '  会话首次加载后缓存，输入 reload 可清除缓存' + C.reset);
  console.log(C.gray + '  ──────────────────────────────────────────────────' + C.reset);
  console.log();
}

/** 显示帮助 */
function showHelp(): void {
  console.log();
  console.log(C.brightCyan + C.bold + '可用命令:' + C.reset);
  console.log();
  console.log(C.yellow + '  会话与消息:' + C.reset);
  console.log('    list                          列出所有会话（联系人）');
  console.log('    send --to <用户> -t "消息"    发送文本消息（默认浏览器签名）');
  console.log('      ↳ --native                  纯 Node.js 原生发送（可能失败）');
  console.log('      ↳ --show-browser            显示浏览器窗口');
  console.log('    send-image --to <用户> -i <路径>  发送图片消息');
  console.log('    send-sticker --to <用户> ...  发送表情贴纸');
  console.log('    reply --to <用户> -r <msgId> -t "..."  引用回复');
  console.log('    recall --to <用户> [--msg-id ID]  撤回消息');
  console.log('    history --to <用户> [--limit N]  获取聊天记录');
  console.log('    watch [--to <用户>] [--ai]    实时监控新消息（--ai 开启白名单AI自动回复）');
  console.log('    ai [--add <uid>|--del <uid>|--list]  AI白名单管理');
  console.log();
  console.log(C.yellow + '  账号管理:' + C.reset);
  console.log('    accounts                      列出已保存账号');
  console.log('    use <name>                    切换账号');
  console.log('    whoami                        查看当前账号');
  console.log('    login <name>                  扫码登录');
  console.log('    logout <name> -f              删除账号');
  console.log('    cookie "<k=v; k=v; ...>"      直接使用 cookie 字符串登录');
  console.log('    cookie-file <path>            从文件读取 cookie 登录');
  console.log('    rename --uid <uid> --name <昵称>  设置备注');
  console.log();
  console.log(C.yellow + '  视频与评论:' + C.reset);
  console.log('    video --to <用户> --aweme-id ID  视频详情');
  console.log('    awemedetail --aweme-id ID     视频详情（来自通知）');
  console.log('    comments --aweme-id ID        评论列表');
  console.log('    comment --aweme-id ID --text "..."  发布评论');
  console.log();
  console.log(C.yellow + '  个人与通知:' + C.reset);
  console.log('    profile                       个人主页信息');
  console.log('    edit-profile --nickname <...>  修改资料');
  console.log('    notices                       互动消息列表');
  console.log('    noticedetail --nid <ID>       通知详情');
  console.log('    collect-sticker --to <用户> -m <msgId>  收藏表情');
  console.log('    ticket-guard --auto           获取签名头');
  console.log();
  console.log(C.yellow + '  内置命令:' + C.reset);
  console.log(`    ${C.green}help${C.reset}    显示此帮助`);
  console.log(`    ${C.green}clear${C.reset}   清屏`);
  console.log(`    ${C.green}reload${C.reset}  清除会话缓存`);
  console.log(`    ${C.green}exit${C.reset}    退出`);
  console.log();
  console.log(C.gray + '  选项: 可在任意命令前加 --json（JSON输出）或 --verbose（调试日志）' + C.reset);
  console.log(C.gray + '  示例: --json list' + C.reset);
  console.log(C.gray + '        send --to TwT -t "你好"' + C.reset);
  console.log(C.gray + '        history --to "张三" --limit 100' + C.reset);
  console.log();
}

/** 启动 REPL */
async function repl(): Promise<void> {
  await loadAndPrintCat();
  printWelcome();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${C.green}${C.bold}◆ sprr> ${C.reset}`,
    completer: (line: string) => {
      const commands = [
        'list', 'send', 'send-image', 'send-sticker', 'reply', 'recall',
        'history', 'watch', 'watch --ai', 'ai', 'ai --add', 'ai --del', 'ai --list', 'ai --refresh', 'accounts', 'use', 'whoami', 'login', 'logout',
        'cookie', 'cookie-file', 'rename', 'video', 'awemedetail', 'comments', 'comment',
        'profile', 'edit-profile', 'notices', 'noticedetail',
        'collect-sticker', 'ticket-guard', 'help', 'clear', 'reload', 'exit',
      ];
      const hits = commands.filter((c) => c.startsWith(line.trim()));
      return [hits.length ? hits : commands, line];
    },
  });

  rl.prompt();

  rl.on('line', async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    // 内置命令
    if (trimmed === 'exit' || trimmed === 'quit') {
      console.log(C.gray + '再见!' + C.reset);
      rl.close();
      process.exit(0);
    }
    if (trimmed === 'clear' || trimmed === 'cls') {
      console.clear();
      rl.prompt();
      return;
    }
    if (trimmed === 'help' || trimmed === '?') {
      showHelp();
      rl.prompt();
      return;
    }
    if (trimmed === 'reload') {
      clearCache();
      catBox('已清除会话缓存');
      rl.prompt();
      return;
    }

    // 解析并执行 commander 命令
    try {
      const args = parseArgs(trimmed);
      const program = createProgram();
      await program.parseAsync(args, { from: 'user' });
    } catch (e: unknown) {
      // commander exitOverride 会抛出异常（如 --help / --version / 错误）
      if (e instanceof Error) {
        const msg = e.message;
        // outputHelp / version 是正常行为，不报错
        if (msg.includes('outputHelp') || msg.includes('CommanderError: version')) {
          // 静默
        } else if (msg.includes('unknown command') || msg.includes('required option')) {
          log.error(`命令错误: ${msg}`);
        } else {
          // 其他错误也不退出
          log.error(`执行异常: ${msg}`);
        }
      } else {
        log.error('执行异常', e);
      }
    }

    // 每条命令后重置 exitCode（V2 不因单条命令失败而退出）
    process.exitCode = undefined;

    // watch 命令会阻塞，执行完毕后才回到这里
    rl.prompt();
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

// ============================ 启动 ============================

repl().catch((e) => {
  log.error('启动失败', e);
  process.exit(1);
});
