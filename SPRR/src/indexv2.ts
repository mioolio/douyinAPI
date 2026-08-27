#!/usr/bin/env node
/**
 * SPRR V2 - 抖音私信聊天自动化工具（交互式 REPL 版本）
 *
 * 架构（模块化重构后）：
 *   cli/ui.ts          颜色常量 + 格式化函数 + catBox
 *   cli/context.ts     全局状态 + session 缓存 + 联系人缓存 + helpers
 *   commands/          各命令模块（register* 函数注册到 commander）
 *   commands/browser-pool.ts  浏览器单例池（核心性能修复）
 *
 * 性能优化：
 *   send / reply / watch --ai 共享 browser-pool 单例，
 *   首次启动浏览器后复用，后续命令免去 5s secsdk 等待。
 *
 * 用法：
 *   pnpm dev:v2
 *   node dist/indexv2.js
 */

import { Command } from 'commander';
import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createLogger } from './utils/logger.js';
import { C, catBox } from './cli/ui.js';
import { cliState, clearCache } from './cli/context.js';
import { closeBrowserSender } from './commands/browser-pool.js';
import { registerAccountCommands } from './commands/account-cmds.js';
import { registerMessageCommands } from './commands/message-cmds.js';
import { registerWatchCommands } from './commands/watch-cmd.js';
import { registerMediaCommands } from './commands/media-cmds.js';
import { registerProfileCommands } from './commands/profile-cmds.js';
import { registerTicketGuardCommand } from './commands/ticket-guard-cmd.js';

const log = createLogger('cli-v2');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MACT_FILE = path.join(__dirname, 'MACT.txt');

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
      cliState.verbose = Boolean(opts.verbose);
      cliState.json = Boolean(opts.json);
      if (opts.state) cliState.statePath = opts.state;
      if (opts.account) cliState.account = opts.account;
      if (opts.cookie) cliState.cookie = opts.cookie;
      if (cliState.verbose) {
        process.env.SPRR_DEBUG = '1';
      }
    })
    .exitOverride(); // 阻止 commander 调用 process.exit

  // 注册各命令模块
  registerAccountCommands(program);
  registerMessageCommands(program);
  registerWatchCommands(program);
  registerMediaCommands(program);
  registerProfileCommands(program);
  registerTicketGuardCommand(program);

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
  console.log(C.gray + '  浏览器单例复用：首次 send 后后续命令秒发' + C.reset);
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
      // 关闭常驻浏览器单例
      await closeBrowserSender();
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
      if (e instanceof Error) {
        const msg = e.message;
        if (msg.includes('outputHelp') || msg.includes('CommanderError: version')) {
          // 静默
        } else if (msg.includes('unknown command') || msg.includes('required option')) {
          log.error(`命令错误: ${msg}`);
        } else {
          log.error(`执行异常: ${msg}`);
        }
      } else {
        log.error('执行异常', e);
      }
    }

    process.exitCode = undefined;
    rl.prompt();
  });

  rl.on('close', async () => {
    await closeBrowserSender();
    process.exit(0);
  });
}

// ============================ 启动 ============================

repl().catch((e) => {
  log.error('启动失败', e);
  process.exit(1);
});
