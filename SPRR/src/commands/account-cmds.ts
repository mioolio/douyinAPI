/**
 * 账号管理命令（login / accounts / use / logout / whoami / cookie / cookie-file / rename）
 */

import type { Command } from 'commander';
import fs from 'node:fs/promises';

import { createLogger } from '../utils/logger.js';
import { C, catBox } from '../cli/ui.js';
import { cliState, clearCache, setCookie, loadAliases, saveAliases } from '../cli/context.js';
import {
  listAccounts,
  getCurrentAccount,
  setCurrentAccount,
  deleteAccount,
  validateAccountName,
  resolveStorageState,
} from '../auth/accounts.js';
import { loadFromStorageState, sessionFromCookieString } from '../auth/session.js';

const log = createLogger('cmd-account');

export function registerAccountCommands(program: Command): void {
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
        const mod = await import('./login.js');
        await mod.loginAccount(name, { timeout, url: opts.url, oc: opts.oc });
        clearCache();
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
      if (cliState.json) {
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
      if (cliState.json) {
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

  /* --------------------------- cookie --------------------------- */
  program
    .command('cookie <string>')
    .description('直接使用 cookie 字符串登录（适用于从 APP 抓包的实时 cookie）')
    .action(async (cookieStr: string) => {
      try {
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
}
