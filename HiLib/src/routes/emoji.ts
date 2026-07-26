/**
 * 表情映射路由
 *
 * 抖音 IM 消息中的表情以文字标记（如 [看]）出现，需替换为对应图标。
 * 映射规则：IRSC/douyin/ 下的每个子目录名是表情文字标记，
 *          目录内的 webp 文件是该表情的图标。
 *
 *   GET /api/emoji/map
 *     返回所有表情映射表 { "[看]": "/api/emoji/image?name=...", ... }
 *
 *   GET /api/emoji/image?name=[看]
 *     返回指定表情的图标文件
 */

import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';

const router = Router();

/** 表情根目录（IRSC/douyin/） */
const EMOJI_ROOT = path.join(process.cwd(), 'IRSC', 'douyin');

/** 缓存的映射表：{ 表情文字标记: 图片绝对路径 } */
let emojiMap: Map<string, string> | null = null;

/** 扫描目录建立映射表（首次调用或手动刷新时执行） */
async function buildEmojiMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let dirs: string[];
  try {
    dirs = await fsp.readdir(EMOJI_ROOT, { withFileTypes: true });
  } catch {
    // 目录不存在或无法读取，返回空映射
    return map;
  }
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    // 目录名即表情文字标记（如 [看]）
    const emojiName = entry.name;
    const emojiDir = path.join(EMOJI_ROOT, emojiName);
    try {
      const files = await fsp.readdir(emojiDir);
      // 找第一个图片文件
      const imgFile = files.find((f) => /\.(webp|png|jpg|jpeg|gif)$/i.test(f));
      if (imgFile) {
        map.set(emojiName, path.join(emojiDir, imgFile));
      }
    } catch {
      // 跳过无法读取的子目录
    }
  }
  return map;
}

/** 获取映射表（带缓存） */
async function getEmojiMap(): Promise<Map<string, string>> {
  if (emojiMap === null) {
    emojiMap = await buildEmojiMap();
  }
  return emojiMap;
}

/** 返回映射表 JSON */
router.get('/map', async (_req, res) => {
  try {
    const map = await getEmojiMap();
    const result: Record<string, string> = {};
    for (const [name] of map) {
      result[name] = `/api/emoji/image?name=${encodeURIComponent(name)}`;
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/** 返回表情图片 */
router.get('/image', async (req, res) => {
  try {
    const name = req.query.name as string;
    if (!name) {
      res.status(400).json({ error: '缺少 name 参数' });
      return;
    }
    const map = await getEmojiMap();
    const filePath = map.get(name);
    if (!filePath || !fs.existsSync(filePath)) {
      res.status(404).json({ error: '表情不存在' });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.webp': 'image/webp',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
    };
    res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.sendFile(filePath);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
