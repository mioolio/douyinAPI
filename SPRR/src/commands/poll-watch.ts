/**
 * 轮询版实时消息监控循环（2026-08 新协议）
 *
 * 替代原 Frontier WebSocket 推送（该通道已下线，抓包证实聊天页 0 个 WS 连接）：
 *   1. cmd2043 初始化同步，取得初始游标（消息游标 µs + 收件箱序号）
 *   2. cmd2048 按间隔轮询，解析新消息 / 会话事件，跟随服务端推进游标
 *   3. 连续失败达到阈值后自动重新 init 重建游标
 *
 * 本模块只负责循环机制；消息展示与 AI 回复触发由调用方通过 onMessage 完成。
 */

import { createLogger } from '../utils/logger.js';
import { C } from '../cli/ui.js';
import {
  initMessageSync,
  pollUserMessage,
  type PollMessage,
} from '../api/polling.js';
import type { RequestEnv } from '../api/imapi.js';

const log = createLogger('cmd-poll-watch');

export interface PollWatchOptions {
  env: RequestEnv;
  myUid: string;
  /** 轮询间隔毫秒（默认 3000，官方客户端实测约 3~6s） */
  intervalMs?: number;
  /** 收到新消息（去重后）回调 */
  onMessage: (msg: PollMessage) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 运行轮询监控，直到 SIGINT（Ctrl+C）。
 * 循环结束/异常均正常返回；致命错误（如 init 失败、cookie 失效）抛出。
 */
export async function runPollingWatch(opts: PollWatchOptions): Promise<void> {
  const { env, myUid, onMessage } = opts;
  const intervalMs = opts.intervalMs ?? 3000;

  // 初始化同步（带重试）
  let cursors;
  let lastInitErr: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      cursors = await initMessageSync(env);
      lastInitErr = null;
      break;
    } catch (e) {
      lastInitErr = e;
      log.warn(`init 第 ${attempt}/3 次失败: ${e}`);
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }
  if (!cursors) {
    throw new Error(`消息同步初始化失败: ${lastInitErr}`);
  }
  log.info(
    `游标就绪: msgCursor=${cursors.messageCursorUs} inboxSeq=${cursors.inboxSeq}`,
  );

  let running = true;
  const seenIds = new Set<string>();
  let consecutiveErrors = 0;

  const onSigInt = () => {
    running = false;
  };
  process.on('SIGINT', onSigInt);

  log.info(`${C.cyan}[watch]${C.reset} 轮询已启动（间隔 ${intervalMs}ms，Ctrl+C 停止）`);
  try {
    while (running) {
      try {
        const result = await pollUserMessage(env, cursors, myUid);
        cursors = result.next;
        consecutiveErrors = 0;

        for (const m of result.messages) {
          const key = m.message.serverMsgId || m.message.msgId;
          if (key) {
            if (seenIds.has(key)) continue;
            seenIds.add(key);
            if (seenIds.size > 500) {
              const first = seenIds.values().next().value;
              if (first) seenIds.delete(first);
            }
          }
          onMessage(m);
        }
      } catch (e) {
        consecutiveErrors++;
        log.warn(`轮询失败（连续第 ${consecutiveErrors} 次）: ${e}`);
        if (consecutiveErrors >= 5) {
          log.warn(`${C.yellow}[watch]${C.reset} 连续失败，重新初始化同步游标...`);
          try {
            cursors = await initMessageSync(env);
            consecutiveErrors = 0;
            log.info(`${C.cyan}[watch]${C.reset} 游标已重建: seq=${cursors.inboxSeq}`);
          } catch (e2) {
            throw new Error(`重新初始化失败（cookie 可能已过期）: ${e2}`);
          }
        }
      }
      if (!running) break;
      // 间隔加 0~1s 抖动，避免固定节奏
      await sleep(intervalMs + Math.floor(Math.random() * 1000));
    }
  } finally {
    process.removeListener('SIGINT', onSigInt);
    log.info(`${C.yellow}[watch]${C.reset} 轮询已停止`);
  }
}
