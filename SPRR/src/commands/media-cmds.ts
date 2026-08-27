/**
 * 视频/评论/贴纸命令（video / awemedetail / comments / comment / collect-sticker）
 */

import type { Command } from 'commander';

import { createLogger } from '../utils/logger.js';
import { C, catBox, divider, output, truncate } from '../cli/ui.js';
import {
  run,
  getContacts,
  resolveTarget,
  getStatePathForBrowser,
  loadAliases,
  buildPrivateCid,
  detectMyUid,
  cliState,
} from '../cli/context.js';
import {
  getVideoDetail,
  getAwemeDetail,
  getCommentList,
  publishComment,
  collectSticker,
  type CommentInfo,
  type TicketGuardHeaders,
} from '../api/webapi.js';
import {
  getHistory,
  type ContactItem,
} from '../api/operations.js';
import {
  loadOrExtractTicketGuard,
  saveTicketGuard,
  isTicketGuardExpired,
  type TicketGuardConfig,
} from '../crypto/ticket-guard.js';
import { autoExtractTicketGuard } from './ticket-guard-auto.js';

const log = createLogger('cmd-media');

/** 加载联系人并应用别名 */
async function loadContactsWithAliases(
  env: ReturnType<typeof import('../api/operations.js').envFromSession>,
): Promise<{ contacts: ContactItem[]; myUid: string }> {
  const contacts = await getContacts(env);
  const aliases = await loadAliases();
  for (const c of contacts) {
    if (aliases[c.uid]) c.nickname = aliases[c.uid];
  }
  const myUid = detectMyUid(contacts);
  return { contacts, myUid };
}

export function registerMediaCommands(program: Command): void {
  /* --------------------------- collect-sticker --------------------------- */
  program
    .command('collect-sticker')
    .description('收藏表情贴纸')
    .requiredOption('-m, --msg-id <serverMsgId>', 'sticker 消息的 server_message_id')
    .option('--to <target>', '目标用户', 'TwT')
    .option('--action <n>', '1=收藏, 0=取消', '1')
    .action(async (opts: { msgId: string; to: string; action: string }) => {
      await run(async ({ env }) => {
        const { contacts, myUid } = await loadContactsWithAliases(env);
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
        const { contacts, myUid } = await loadContactsWithAliases(env);
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
        if (cliState.json) {
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
        if (cliState.json) {
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
}
