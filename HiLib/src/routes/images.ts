/**
 * 图片路由
 *
 *   GET /api/images/decrypt?msgId=xxx&cid=xxx&shortId=xxx
 *     解密加密图片（msgType=91，阅后即焚/永久加密）
 *     通过 read_once/detail 接口获取 skey + URL，下载密文后 AES-256-GCM 解密
 *     首次调用会下载图片到本地缓存，后续直接返回缓存
 *
 *   GET /api/images/decrypt-plain?url=xxx&skey=xxx&msgId=xxx&cid=xxx
 *     解密普通图片（msgType=27，skey 在消息 content.resource_url.skey）
 *     普通图片的 CDN URL 返回的也是 AES-256-GCM 密文，需要用 skey 解密
 *
 *   GET /api/images/decrypt-by-oid?oid=xxx&skey=xxx&msgId=xxx&cid=xxx
 *     解密自己发送的图片（消息中只有 oid + skey，无 URL）
 *     先用 oid 调 batch_build_image 换签名 URL，再下载密文 + AES-256-GCM 解密
 *
 *   GET /api/images/proxy?url=xxx
 *     代理下载抖音 CDN 图片（无 skey 场景，如视频封面）
 *     抖音图片 URL 检查 Referer，前端直接 <img src> 会失败，需通过后端代理
 *     本地缓存 7 天，避免重复下载
 */

import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import crypto from 'node:crypto';
import { decryptImageForMessage, decryptPlainImage, decryptImageByOid } from '../services/sprrService.js';
import { getDecryptedImage } from '../services/db.js';
import { getCurrentAccount } from '../sprr/auth/accounts.js';

const router = Router();

const PROXY_CACHE_DIR = path.join(process.cwd(), 'data', 'images', '_proxy_cache');

/** 确保 proxy 缓存目录存在 */
async function ensureProxyCacheDir(): Promise<void> {
  await fsPromises.mkdir(PROXY_CACHE_DIR, { recursive: true });
}

/** 检测图片格式并返回 MIME + 扩展名 */
function detectImageFormat(buf: Buffer): { mime: string; ext: string } {
  if (buf.length < 12) return { mime: 'application/octet-stream', ext: 'bin' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: 'image/png', ext: 'png' };
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return { mime: 'image/webp', ext: 'webp' };
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { mime: 'image/gif', ext: 'gif' };
  if (buf[0] === 0x42 && buf[1] === 0x4d) return { mime: 'image/bmp', ext: 'bmp' };
  return { mime: 'application/octet-stream', ext: 'bin' };
}

/** 根据 URL 生成稳定的缓存文件路径 */
function getProxyCachePath(url: string): string {
  const hash = crypto.createHash('sha1').update(url).digest('hex');
  return path.join(PROXY_CACHE_DIR, `${hash}`);
}

router.get('/get', async (req, res) => {
  try {
    const msgId = req.query.msgId as string;
    const cid = req.query.cid as string;
    const url = req.query.url as string;
    const skey = req.query.skey as string;
    const oid = req.query.oid as string;
    const account = (req.query.account as string) || undefined;

    if (!msgId || !cid) {
      res.status(400).json({ error: '缺少 msgId/cid 参数' });
      return;
    }

    let filePath: string | null = null;

    const accountName = account || (await getCurrentAccount()) || '';

    const cached = getDecryptedImage(accountName, msgId);
    if (cached && cached.local_path && fs.existsSync(cached.local_path)) {
      filePath = cached.local_path;
    } else if (url && skey) {
      filePath = await decryptPlainImage(url, skey, msgId, cid, account);
    } else if (oid && skey) {
      filePath = await decryptImageByOid(oid, skey, msgId, cid, account);
    }

    if (!filePath) {
      res.status(404).json({ error: '图片获取失败' });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
    };
    const mime = mimeMap[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.sendFile(filePath);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.get('/decrypt', async (req, res) => {
  try {
    const msgId = req.query.msgId as string;
    const cid = req.query.cid as string;
    const shortId = req.query.shortId as string;
    const account = (req.query.account as string) || undefined;

    if (!msgId || !cid || !shortId) {
      res.status(400).json({ error: '缺少 msgId/cid/shortId 参数' });
      return;
    }

    // 统一使用 decryptImageForMessage（自动判断永久/阅后即焚）
    const filePath = await decryptImageForMessage(msgId, cid, shortId, account);
    if (!filePath) {
      res.status(404).json({ error: '图片解密失败或已被查看过' });
      return;
    }

    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: '缓存文件不存在' });
      return;
    }

    // 返回图片文件
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
    };
    const mime = mimeMap[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.sendFile(filePath);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * 解密普通图片（msgType=27）
 *
 * 普通图片的 CDN URL 返回的是 AES-256-GCM 密文，需要用消息中的 skey 解密。
 * skey 来自消息 content.resource_url.skey（已存入数据库 image_skey 列）。
 */
router.get('/decrypt-plain', async (req, res) => {
  try {
    const url = req.query.url as string;
    const skey = req.query.skey as string;
    const msgId = req.query.msgId as string;
    const cid = req.query.cid as string;
    const account = (req.query.account as string) || undefined;

    if (!url || !skey || !msgId || !cid) {
      res.status(400).json({ error: '缺少 url/skey/msgId/cid 参数' });
      return;
    }

    const filePath = await decryptPlainImage(url, skey, msgId, cid, account);
    if (!filePath) {
      res.status(404).json({ error: '图片解密失败' });
      return;
    }

    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: '缓存文件不存在' });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
    };
    const mime = mimeMap[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.sendFile(filePath);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * 解密自己发送的图片（消息中只有 oid + skey，无 URL）
 *
 * 流程：用 oid 调 batch_build_image 接口换签名 URL，再下载密文 + AES-256-GCM 解密。
 * skey / oid 来自消息 content.resource_url.skey / content.resource_url.oid（已存入数据库）。
 */
router.get('/decrypt-by-oid', async (req, res) => {
  try {
    const oid = req.query.oid as string;
    const skey = req.query.skey as string;
    const msgId = req.query.msgId as string;
    const cid = req.query.cid as string;
    const account = (req.query.account as string) || undefined;

    if (!oid || !skey || !msgId || !cid) {
      res.status(400).json({ error: '缺少 oid/skey/msgId/cid 参数' });
      return;
    }

    const filePath = await decryptImageByOid(oid, skey, msgId, cid, account);
    if (!filePath) {
      res.status(404).json({ error: '图片解密失败' });
      return;
    }

    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: '缓存文件不存在' });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.gif': 'image/gif',
      '.bmp': 'image/bmp',
    };
    const mime = mimeMap[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.sendFile(filePath);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

/**
 * 代理下载抖音 CDN 图片
 *
 * 抖音图片 URL 需要带 Referer: https://www.douyin.com/ 才能正常访问，
 * 前端直接 <img src="https://p3-sign.douyinpic.com/..."> 会失败。
 * 通过此接口代理下载并缓存到本地。
 */
router.get('/proxy', async (req, res) => {
  try {
    const url = req.query.url as string;
    if (!url) {
      res.status(400).json({ error: '缺少 url 参数' });
      return;
    }
    // 仅允许抖音 CDN 域名，防止被滥用为开放代理
    const allowedHosts = ['douyinpic.com', 'douyin.com', 'byteimg.com', 'ixigua.com'];
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      res.status(400).json({ error: 'url 参数格式无效' });
      return;
    }
    const hostname = parsedUrl.hostname;
    if (!allowedHosts.some((h) => hostname === h || hostname.endsWith(`.${h}`))) {
      res.status(403).json({ error: '仅允许代理抖音相关域名' });
      return;
    }

    await ensureProxyCacheDir();
    const cachePath = getProxyCachePath(url);

    // 命中缓存：直接返回
    if (fs.existsSync(cachePath)) {
      const buf = fs.readFileSync(cachePath);
      const { mime } = detectImageFormat(buf);
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'public, max-age=604800');
      res.send(buf);
      return;
    }

    // 下载图片（带 Referer）
    const resp = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        referer: 'https://www.douyin.com/',
        accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
    });
    if (!resp.ok) {
      res.status(resp.status).json({ error: `下载失败 HTTP ${resp.status}` });
      return;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length === 0) {
      res.status(502).json({ error: '下载内容为空' });
      return;
    }

    // 缓存到本地
    fs.writeFileSync(cachePath, buf);

    const { mime } = detectImageFormat(buf);
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

export default router;
