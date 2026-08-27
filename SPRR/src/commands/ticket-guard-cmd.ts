/**
 * ticket-guard 命令（管理 bd-ticket-guard 签名头）
 */

import type { Command } from 'commander';

import { createLogger } from '../utils/logger.js';
import { C, catBox } from '../cli/ui.js';
import { getStatePathForBrowser, cliState } from '../cli/context.js';
import {
  loadTicketGuard,
  saveTicketGuard,
  extractTicketGuardFromCapture,
  isTicketGuardExpired,
  type TicketGuardConfig,
} from '../crypto/ticket-guard.js';
import { autoExtractTicketGuard } from './ticket-guard-auto.js';

const log = createLogger('cmd-ticket-guard');

export function registerTicketGuardCommand(program: Command): void {
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
        if (cliState.json) {
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
}
