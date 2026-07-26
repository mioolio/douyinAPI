/**
 * 会话列表路由
 *
 *   GET /api/contacts?account=<name>&cached=1   获取会话列表
 *     cached=1 时仅返回本地数据库缓存（秒级响应，无网络请求）
 *     不传 cached 时从服务器拉取最新数据
 */

import { Router } from 'express';
import {
  getContactList,
  getCachedContactList,
} from '../services/sprrService.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const account = (req.query.account as string) || undefined;
    const cached = req.query.cached === '1';

    if (cached && account) {
      // 仅返回本地缓存（无网络请求）
      const contacts = getCachedContactList(account);
      res.json({ contacts, cached: true });
      return;
    }

    const contacts = await getContactList(account);
    res.json({ contacts, cached: false });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
