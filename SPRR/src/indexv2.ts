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

import { Command, CommanderError } from 'commander';
import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createLogger, setLogVerbose } from './utils/logger.js';
import { C, catBox } from './cli/ui.js';
import { cliState, clearCache, setSessionSource, applyCommandSessionSource, restoreCommandSessionSource, getCurrentConversation } from './cli/context.js';
import { CommandQueue } from './cli/command-queue.js';
import { watchControl, stopWatchOrClose } from './cli/watch-control.js';
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
const outputDefaults = { verbose: false, json: false };

function applyOutputState(options: { verbose: boolean; json: boolean }): void {
  cliState.verbose = options.verbose;
  cliState.json = options.json;
  setLogVerbose(options.verbose);
}

export function setReplOutputDefaults(options: { verbose?: boolean; json?: boolean }): void {
  if (options.verbose !== undefined) outputDefaults.verbose = options.verbose;
  if (options.json !== undefined) outputDefaults.json = options.json;
  applyOutputState(outputDefaults);
}

// ============================ 命令注册 ============================

export function createProgram(onWatchStart?: () => void): Command {
  const program = new Command();
  program
    .name('sprr')
    .description('抖音私信聊天自动化工具（交互式 V2）')
    .version('0.0.1')
    .option('--verbose', '输出详细日志（debug 级别）', outputDefaults.verbose)
    .option('--no-verbose', '关闭详细日志')
    .option('--json', '以 JSON 格式输出结果', outputDefaults.json)
    .option('--no-json', '使用普通输出格式')
    .option('--state <path>', 'storageState 文件路径', undefined)
    .option('--account <name>', '临时使用指定账号', undefined)
    .option('--cookie <string>', '直接使用 cookie 字符串（优先级最高，无需登录）', undefined)
    .hook('preAction', async (_command, actionCommand) => {
      if (actionCommand.name() === 'watch') {
        watchControl.start();
        onWatchStart?.();
      }
      const opts = program.opts();
      applyOutputState({ verbose: Boolean(opts.verbose), json: Boolean(opts.json) });
      await applyCommandSessionSource(opts);
    })
    .hook('postAction', async () => {
      watchControl.finish();
      await restoreCommandSessionSource();
      applyOutputState(outputDefaults);
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

/** A line containing only global options changes the REPL defaults. */
export async function configureReplOptions(args: string[]): Promise<boolean> {
  if (args.length === 0) return false;
  const program = createProgram();
  const parsed = program.parseOptions(args);
  if (parsed.operands.length || parsed.unknown.length) return false;
  const opts = program.opts();
  const explicit = (key: string) => program.getOptionValueSource(key) === 'cli';
  setReplOutputDefaults({
    verbose: explicit('verbose') ? Boolean(opts.verbose) : undefined,
    json: explicit('json') ? Boolean(opts.json) : undefined,
  });
  if (explicit('cookie') || explicit('state') || explicit('account')) {
    await setSessionSource(opts.cookie ? { cookie: opts.cookie }
      : opts.state ? { statePath: opts.state } : { account: opts.account });
  }
  return true;
}

// ============================ REPL 实现 ============================

/** 解析输入行，支持引号 */
export function parseArgs(line: string): string[] {
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
  console.log(C.gray + '  list 刷新未读状态；昵称与已加载消息复用缓存' + C.reset);
  console.log(C.gray + '  history --to <用户> 选择当前会话；reload 清除缓存' + C.reset);
  console.log(C.gray + '  首次发送初始化浏览器，后续发送复用；--verbose 查看诊断' + C.reset);
  console.log(C.gray + '  ──────────────────────────────────────────────────' + C.reset);
  console.log();
}

/** 显示帮助 */
function showHelp(): void {
  console.log();
  console.log(C.brightCyan + C.bold + '可用命令:' + C.reset);
  console.log();
  console.log(C.yellow + '  会话与消息:' + C.reset);
  console.log('    list [--refresh-strangers]    刷新会话列表（陌生人查询遵守限流冷却）');
  console.log('    send --to <用户> -t "消息"    发送文本消息（默认浏览器签名）');
  console.log('      ↳ --native                  纯 Node.js 原生发送（可能失败）');
  console.log('      ↳ --show-browser            显示浏览器窗口');
  console.log('    send-image --to <用户> -i <路径>  发送图片消息');
  console.log('    send-sticker --to <用户> ...  发送表情贴纸');
  console.log('    reply --to <用户> -r <msgId> -t "..."  引用回复');
  console.log('    recall --to <用户> [--msg-id ID]  撤回消息');
  console.log('    history --to <用户> [--limit N]  获取聊天记录');
  console.log('      ↳ --download-images        下载普通图片');
  console.log('      ↳ --read-once              读取阅后即焚图片，会消耗一次查看机会');
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
  console.log(C.gray + '        send --to #1 -t "你好"    使用最后一次 list 的序号' + C.reset);
  console.log(C.gray + '  history 选定会话后可省略 --to；重名时请使用 UID 或会话 ID' + C.reset);
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

  const queue = new CommandQueue();
  let closing = false;
  let inputClosed = false;
  let exitQueued = false;
  const prompt = () => {
    if (closing || inputClosed) return;
    const current = getCurrentConversation();
    const label = current ? ` [${current.nickname || current.uid}]` : '';
    rl.setPrompt(`${C.green}${C.bold}◆ sprr${label}> ${C.reset}`);
    rl.prompt();
  };

  prompt();

  const executeLine = async (line: string) => {
    if (closing) return;
    const trimmed = line.trim();
    if (!trimmed) {
      prompt();
      return;
    }

    // 内置命令
    if (trimmed === 'exit' || trimmed === 'quit') {
      console.log(C.gray + '再见!' + C.reset);
      closing = true;
      rl.close();
      return;
    }
    if (trimmed === 'clear' || trimmed === 'cls') {
      console.clear();
      prompt();
      return;
    }
    if (trimmed === 'help' || trimmed === '?') {
      showHelp();
      prompt();
      return;
    }
    if (trimmed === 'reload') {
      await clearCache();
      catBox('已清除会话缓存');
      prompt();
      return;
    }

    // 解析并执行 commander 命令
    try {
      const args = parseArgs(trimmed);
      if (await configureReplOptions(args)) {
        catBox('REPL 默认选项已更新');
      } else {
        const program = createProgram(() => { if (inputClosed || exitQueued) watchControl.requestStop(); });
        await program.parseAsync(args, { from: 'user' });
      }
    } catch (e: unknown) {
      if (e instanceof CommanderError && e.exitCode === 0) {
        // Help and version output are successful commands.
      } else if (e instanceof Error) {
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
    } finally {
      watchControl.finish();
      await restoreCommandSessionSource();
      applyOutputState(outputDefaults);
    }

    process.exitCode = undefined;
    prompt();
  };

  rl.on('line', (line: string) => {
    if (/^(?:exit|quit)$/.test(line.trim())) {
      exitQueued = true;
      watchControl.requestStop();
    }
    void queue.enqueue(() => executeLine(line)).catch((error) => log.error('命令执行失败', error));
  });

  rl.on('SIGINT', () => stopWatchOrClose(() => rl.close()));

  rl.on('close', () => {
    inputClosed = true;
    watchControl.requestStop();
    void queue.drain().then(async () => {
      closing = true;
      await closeBrowserSender();
      process.exit(0);
    }).catch((error) => { log.error('退出失败', error); process.exit(1); });
  });
}

// ============================ 启动 ============================

export async function main(args = process.argv.slice(2)): Promise<void> {
  try {
    if (args.length === 0 || await configureReplOptions(args)) {
      await repl();
      return;
    }
    try {
      await createProgram().parseAsync(args, { from: 'user' });
    } finally {
      watchControl.finish();
      await restoreCommandSessionSource();
      applyOutputState(outputDefaults);
      await closeBrowserSender();
    }
  } catch (error) {
    if (!(error instanceof CommanderError && error.exitCode === 0)) throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    log.error('启动失败', e);
    process.exit(1);
  });
}
