/**
 * 账号管理路由
 *
 *   GET    /api/auth/accounts          列出所有账号
 *   GET    /api/auth/current           获取当前账号
 *   POST   /api/auth/use               切换当前账号  { name }
 *   DELETE /api/auth/accounts/:name    删除账号
 *   POST   /api/auth/import-cookie     手动导入 cookie  { name, cookie }
 *   POST   /api/auth/login             扫码登录（不传 name，登录后自动用 uid_tt 命名）  { timeout? }
 *   POST   /api/auth/scan              扫描本机 Chrome/Edge 已登录的抖音账号
 *   POST   /api/auth/import-scanned    导入选中的扫描账号  { accounts: ScannedAccount[] }
 */

import { Router } from 'express';
import {
  listAllAccounts,
  getCurrent,
  getMyProfile,
  useAccount,
  removeAccount,
  importCookie,
  loginWithBrowser,
  scanBrowserAccounts,
  importScannedAccounts,
} from '../services/sprrService.js';

const router = Router();

router.get('/accounts', async (_req, res) => {
  try {
    const accounts = await listAllAccounts();
    const current = await getCurrent();
    res.json({ accounts, current });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.get('/current', async (_req, res) => {
  try {
    const current = await getCurrent();
    res.json({ current });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.get('/profile', async (_req, res) => {
  try {
    const profile = await getMyProfile();
    res.json(profile);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.post('/use', async (req, res) => {
  try {
    const { name } = req.body ?? {};
    if (!name) {
      res.status(400).json({ error: '缺少 name 参数' });
      return;
    }
    await useAccount(name);
    res.json({ success: true, current: name });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.delete('/accounts/:name', async (req, res) => {
  try {
    await removeAccount(req.params.name);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.post('/import-cookie', async (req, res) => {
  try {
    const { name, cookie } = req.body ?? {};
    if (!cookie) {
      res.status(400).json({ error: '缺少 cookie 参数' });
      return;
    }
    const accountName = await importCookie(name, cookie);
    res.json({ success: true, name: accountName });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * 扫码登录
 *
 * 不需要传 name：登录后自动从 cookie 提取 uid_tt 作为账号名。
 * 此接口会阻塞直到登录完成或超时。前端应使用长连接或轮询状态。
 * 注意：服务端必须能启动 headful Chromium（仅限本地开发环境）。
 */
router.post('/login', async (req, res) => {
  try {
    const { timeout } = req.body ?? {};
    const name = await loginWithBrowser({ timeout: timeout ? Number(timeout) : undefined });
    res.json({ success: true, name });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * 扫描本机 Chrome/Edge 已登录的抖音账号
 *
 * 返回扫描到的账号列表（含浏览器来源、profile、uid、sessionid）。
 * 前端展示供用户勾选后调用 /import-scanned 导入。
 */
router.post('/scan', async (_req, res) => {
  try {
    const accounts = await scanBrowserAccounts();
    res.json({ accounts });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * 导入选中的扫描账号
 *
 * body: { accounts: ScannedAccount[] }
 * 用 uid_tt 作为账号名保存。
 */
router.post('/import-scanned', async (req, res) => {
  try {
    const { accounts } = req.body ?? {};
    if (!Array.isArray(accounts) || accounts.length === 0) {
      res.status(400).json({ error: '缺少 accounts 参数或为空' });
      return;
    }
    const imported = await importScannedAccounts(accounts);
    res.json({ success: true, imported });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
