/**
 * 消息路由
 *
 *   GET  /api/messages?cid=<conversationId>&limit=<n>&account=<name>&cursor=<cursor>   获取历史消息
 *     cursor 不传 = 首次加载最新消息；传上次返回的 nextCursor = 加载更早消息
 *   POST /api/messages/send   发送文本消息  { cid, text, account? }
 *   POST /api/messages/image  发送图片消息  { cid, image, account? }
 *     image 为 data URL（data:image/jpeg;base64,...）或纯 base64 字符串
 */

import { Router } from 'express';
import { getCurrentAccount } from '../sprr/auth/accounts.js';
import {
  getMessageHistory,
  getCachedMessageHistory,
  sendTextMessage,
  sendImageMessage,
} from '../services/sprrService.js';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const cid = req.query.cid as string;
    if (!cid) {
      res.status(400).json({ error: '缺少 cid 参数' });
      return;
    }
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 30;
    const account = (req.query.account as string) || undefined;
    const cursor = (req.query.cursor as string) || undefined;
    // cached=1 时只返回本地缓存消息（无网络请求，秒级响应）
    // 用于切换会话时先快速显示缓存，再后台拉取最新
    if (req.query.cached === '1') {
      const accountName = account || (await getCurrentAccount()) || '';
      const messages = getCachedMessageHistory(accountName, cid, limit);
      res.json({ messages, hasMore: false, nextCursor: '' });
      return;
    }

    const result = await getMessageHistory(cid, limit, account, cursor);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.post('/send', async (req, res) => {
  try {
    const { cid, text, account } = req.body ?? {};
    if (!cid || !text) {
      res.status(400).json({ error: '缺少 cid 或 text 参数' });
      return;
    }
    const result = await sendTextMessage(cid, text, account);
    if (result.success) {
      res.json({ success: true, msgId: result.msgId, serverMsgId: result.serverMsgId });
    } else {
      res.status(400).json({ success: false, error: result.reason || '发送失败' });
    }
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.post('/image', async (req, res) => {
  try {
    const { cid, image, account } = req.body ?? {};
    if (!cid || !image) {
      res.status(400).json({ error: '缺少 cid 或 image 参数' });
      return;
    }
    // 解析 base64：支持 data URL（data:image/jpeg;base64,...）和纯 base64
    const base64Match = typeof image === 'string'
      ? image.match(/^data:image\/[a-zA-Z]+;base64,(.+)$/)
      : null;
    const base64Data = base64Match ? base64Match[1] : (typeof image === 'string' ? image : '');
    if (!base64Data) {
      res.status(400).json({ error: 'image 参数格式无效' });
      return;
    }
    const imageBytes = Buffer.from(base64Data, 'base64');
    if (imageBytes.length === 0) {
      res.status(400).json({ error: '图片数据为空' });
      return;
    }
    const result = await sendImageMessage(cid, imageBytes, account);
    if (result.success) {
      res.json({ success: true, msgId: result.msgId, serverMsgId: result.serverMsgId });
    } else {
      res.status(400).json({ success: false, error: result.reason || '发送失败' });
    }
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
