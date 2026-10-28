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
  captureCommandTarget,
  confirmCommandTarget,
  getStatePathForBrowser,
  loadAliases,
  buildPrivateCid,
  getMyUid,
  cliState,
} from '../cli/context.js';
import {
  getVideoDetail,
  getAwemeDetail,
  getCommentList,
  publishComment,
  collectSticker,
  type CommentInfo,
  type PublishCommentOptions,
  type PublishCommentResult,
  type TicketGuardHeaders,
} from '../api/webapi.js';
import {
  getHistory,
  type ContactItem,
} from '../api/operations.js';
import { publishCommentViaBrowser } from './browser-comment.js';

const log = createLogger('cmd-media');

export interface CommentCommandOptions {
  awemeId: string;
  text: string;
  replyId?: string;
  atUid?: string;
  atSecUid?: string;
  ticketGuardClientData?: string;
  ticketGuardReePublicKey?: string;
  ttSessionDtrait?: string;
}

/** V1/V2 share validation, transport selection, and publish-result handling. */
export async function executeCommentCommand(
  opts: CommentCommandOptions,
  context: {
    env: Parameters<typeof publishComment>[0];
    json: boolean;
    getStatePath: () => Promise<string>;
  },
): Promise<void> {
  let result: PublishCommentResult;
  let publishing = false;
  try {
    if (!/^[1-9]\d*$/.test(opts.awemeId)) throw new Error('--aweme-id 必须是有效的数字视频 ID');
    if (!opts.text.trim()) throw new Error('--text 评论内容不能为空');
    if (opts.replyId !== undefined && !/^\d+$/.test(opts.replyId)) {
      throw new Error('--reply-id 必须是数字评论 ID，顶级评论可省略或传 0');
    }
    const manualValues = [opts.ticketGuardClientData, opts.ticketGuardReePublicKey, opts.ttSessionDtrait];
    const hasManual = manualValues.some((value) => value !== undefined);
    if (hasManual && !manualValues.every((value) => value?.trim())) {
      throw new Error('手动签名必须同时提供 --ticket-guard-client-data、--ticket-guard-ree-public-key 和 --tt-session-dtrait');
    }
    const textExtra: NonNullable<PublishCommentOptions['textExtra']> = [];
    if (opts.atUid !== undefined || opts.atSecUid !== undefined) {
      if (!opts.atUid?.trim() || !opts.atSecUid?.trim()) {
        throw new Error('--at-uid 和 --at-sec-uid 必须成对提供');
      }
      const uids = opts.atUid.split(',').map((value) => value.trim());
      const secUids = opts.atSecUid.split(',').map((value) => value.trim());
      if (uids.length !== secUids.length || uids.some((value) => !/^\d+$/.test(value)) || secUids.some((value) => !value)) {
        throw new Error('--at-uid 和 --at-sec-uid 必须一一对应，uid 为数字且所有值不能为空');
      }
      let searchStart = 0;
      for (let i = 0; i < uids.length; i++) {
        const placeholder = `@${i + 1}`;
        const match = new RegExp(`${placeholder}(?!\\d)`).exec(opts.text.slice(searchStart));
        if (!match) throw new Error(`评论内容缺少 @ 用户占位符 ${placeholder}，请按 @1、@2 的顺序填写`);
        const start = searchStart + match.index;
        const end = start + placeholder.length;
        textExtra.push({ user_id: uids[i], sec_uid: secUids[i], type: 0, start, end });
        searchStart = end;
      }
    }
    const publishOpts: PublishCommentOptions = {
      awemeId: opts.awemeId, text: opts.text, replyId: opts.replyId, textExtra,
    };
    if (hasManual) {
      publishing = true;
      result = await publishComment(context.env, publishOpts, {
        clientData: opts.ticketGuardClientData!,
        reePublicKey: opts.ticketGuardReePublicKey!,
        sessionDtrait: opts.ttSessionDtrait!,
      });
    } else {
      const statePath = await context.getStatePath();
      publishing = true;
      result = await publishCommentViaBrowser(statePath, publishOpts);
    }
  } catch (error) {
    result = {
      success: false,
      reason: error instanceof Error ? error.message : String(error),
      outcome: publishing ? 'unknown' : 'rejected',
    };
  }
  if (!result.success) {
    const detail = result.reason || '服务端未确认评论发布成功';
    log.error(`评论发布失败: ${detail}`);
    if (result.outcome === 'unknown') log.warn('发布结果未知，请先检查评论是否已发出，避免重复发布');
    if (context.json) console.log(JSON.stringify({ ...result, reason: detail }, null, 2));
    process.exitCode = 1;
    return;
  }
  if (context.json) {
    console.log(JSON.stringify({ success: true, commentId: result.commentId }, null, 2));
    return;
  }
  catBox('评论发布成功');
  log.info(`  cid: ${C.gray}${result.commentId}${C.reset}`);
}

/** 加载联系人并应用别名 */
async function loadContactsWithAliases(
  env: ReturnType<typeof import('../api/operations.js').envFromSession>,
): Promise<{ contacts: ContactItem[]; myUid: string }> {
  const contacts = await getContacts(env);
  const aliases = await loadAliases();
  for (const c of contacts) {
    if (aliases[c.uid]) c.nickname = aliases[c.uid];
  }
  const myUid = getMyUid(env);
  return { contacts, myUid };
}

export function registerMediaCommands(program: Command): void {
  /* --------------------------- collect-sticker --------------------------- */
  program
    .command('collect-sticker')
    .description('收藏表情贴纸')
    .requiredOption('-m, --msg-id <serverMsgId>', 'sticker 消息的 server_message_id')
    .option('--to <target>', '目标用户（默认当前会话）')
    .option('--action <n>', '1=收藏, 0=取消', '1')
    .action(async (opts: { msgId: string; to?: string; action: string }) => {
      const targetSelection = captureCommandTarget(opts.to);
      if (!targetSelection) { log.error('请指定 --to <用户>，或先用 history 选择当前会话'); return; }
      await run(async ({ env }) => {
        const targetName = confirmCommandTarget(targetSelection);
        const { contacts, myUid } = await loadContactsWithAliases(env);
        const target = await resolveTarget(env, targetName, myUid, contacts);
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
    .option('--to <target>', '目标用户（默认当前会话）')
    .option('--aweme-id <id>', '视频 aweme_id')
    .option('--msg-id <serverMsgId>', '从历史视频分享消息中提取 aweme_id')
    .action(async (opts: { to?: string; awemeId?: string; msgId?: string }) => {
      const targetSelection = captureCommandTarget(opts.to);
      if (!targetSelection) { log.error('请指定 --to <用户>，或先用 history 选择当前会话'); return; }
      await run(async ({ env }) => {
        const targetName = confirmCommandTarget(targetSelection);
        const { contacts, myUid } = await loadContactsWithAliases(env);
        const target = await resolveTarget(env, targetName, myUid, contacts);
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
    .description('发布评论或回复（默认由浏览器在当前会话内自动签名）')
    .requiredOption('--aweme-id <id>', '目标视频 aweme_id')
    .requiredOption('--text <content>', '评论内容')
    .option('--reply-id <cid>', '被回复评论 cid，0 表示顶级评论')
    .option('--at-uid <uid>', '@用户 uid（多个用逗号分隔，正文使用 @1、@2 占位符）')
    .option('--at-sec-uid <sec_uid>', '@用户 sec_uid（与 uid 一一对应）')
    .option('--ticket-guard-client-data <v>', '手动 bd-ticket-guard-client-data（须同时提供三头）')
    .option('--ticket-guard-ree-public-key <v>', '手动 bd-ticket-guard-ree-public-key')
    .option('--tt-session-dtrait <v>', '手动 x-tt-session-dtrait')
    .action(async (opts: CommentCommandOptions) => {
      await run(async ({ env }) => {
        await executeCommentCommand(opts, { env, json: cliState.json, getStatePath: getStatePathForBrowser });
      });
    });
}
