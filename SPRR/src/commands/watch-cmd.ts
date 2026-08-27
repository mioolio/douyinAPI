/**
 * watch + ai 命令（实时消息监控 / AI 自动回复）
 *
 * 性能优化：watch --ai 复用 browser-pool 单例，不再单独创建/关闭浏览器。
 * 退出 watch 时仅解除 ai-reply 的引用（setBrowserSender(null)），
 * 不关闭浏览器实例，后续 send/reply 可继续复用。
 */

import type { Command } from 'commander';

import { createLogger } from '../utils/logger.js';
import { C, divider } from '../cli/ui.js';
import {
  run,
  getContacts,
  resolveTarget,
  getStatePathForBrowser,
  loadAliases,
  buildPrivateCid,
  detectMyUid,
} from '../cli/context.js';
import { connectFrontier, type FrontierFrame } from '../api/frontier.js';
import { extractWsAccessKey } from './extract-ws-key.js';
import { getBrowserSender } from './browser-pool.js';
import {
  handleIncomingMessageViaHistory,
  refreshWhitelist,
  addWhitelist,
  removeWhitelist,
  processUnreadMessages,
  setBrowserSender,
} from '../ai-reply.js';

const log = createLogger('cmd-watch');

export function registerWatchCommands(program: Command): void {
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
        let usedPoolBrowser = false;
        if (opts.ai) {
          log.info(`${C.brightMagenta}[watch]${C.reset} AI 自动回复已开启，正在加载本地白名单...`);
          await refreshWhitelist();
          log.info(`${C.brightMagenta}[watch]${C.reset} 仅白名单内用户会收到 AI 回复，其他消息只记录不回复`);
          // 复用 browser-pool 单例（与 send/reply 共享，避免重复启动浏览器）
          log.info(`${C.brightMagenta}[watch]${C.reset} 正在获取浏览器发送器（复用单例池）...`);
          try {
            const statePath = await getStatePathForBrowser();
            const sender = await getBrowserSender(statePath, true);
            setBrowserSender(sender);
            usedPoolBrowser = true;
          } catch (e) {
            log.warn(`[watch] 浏览器发送器获取失败，AI 回复将使用原生发送（可能失败）: ${e}`);
          }
          // 启动时检查白名单用户的未读消息（处理离线期间错过的消息）
          log.info(`${C.brightMagenta}[watch]${C.reset} 正在检查未读消息...`);
          try {
            const { loadReplyLog } = await import('./../auth/reply-log.js');
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
        // watch 模式下 Ctrl+C 关闭连接返回 REPL
        const onSigInt = async () => {
          console.log();
          log.info(`${C.yellow}[watch]${C.reset} 正在关闭连接...`);
          conn.close();
          // 仅解除 ai-reply 引用，不关闭浏览器（留在单例池供后续 send/reply 复用）
          if (usedPoolBrowser) {
            setBrowserSender(null);
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
          log.info(`${C.brightGreen}[新消息]${C.reset} ${nickname} | 推送: ${text}`);
          log.debug(`[watch调试] direction=${p.direction} msgType=${p.msgType} cid=${cid} myUid=${myUid}`);
          if (opts.ai) {
            handleIncomingMessageViaHistory(cid, myUid, contacts, env).catch((e) => {
              log.error(`[AI回复] 异常: ${e}`);
            });
          }
        }
      });
    });
}
