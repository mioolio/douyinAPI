/**
 * 个人/通知命令（profile / edit-profile / notices / noticedetail）
 */

import type { Command } from 'commander';

import { createLogger } from '../utils/logger.js';
import { C, catBox, divider, output, noticeTypeLabel, truncate } from '../cli/ui.js';
import { run, getStatePathForBrowser, cliState } from '../cli/context.js';
import type { TicketGuardHeaders } from '../api/webapi.js';
import {
  loadOrExtractTicketGuard,
  saveTicketGuard,
  isTicketGuardExpired,
} from '../crypto/ticket-guard.js';
import { autoExtractTicketGuard } from './ticket-guard-auto.js';

const log = createLogger('cmd-profile');

export function registerProfileCommands(program: Command): void {
  /* --------------------------- profile --------------------------- */
  program
    .command('profile')
    .description('获取当前账号主页信息')
    .action(async () => {
      await run(async ({ env }) => {
        const { getSelfProfile } = await import('./profile.js');
        const profile = await getSelfProfile(env);
        if (cliState.json) {
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
        const { editProfile } = await import('./profile.js');
        let ticketGuard: TicketGuardHeaders | undefined;
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
        if (cliState.json) {
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
        const { getNotices } = await import('./profile.js');
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
        if (cliState.json) {
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
        const { getNoticeDetail } = await import('./profile.js');
        const n = await getNoticeDetail(env, opts.nid);
        if (!n) {
          log.warn(`未找到通知: nid=${opts.nid}`);
          return;
        }
        if (cliState.json) {
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
}
