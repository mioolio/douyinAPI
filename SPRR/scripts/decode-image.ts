#!/usr/bin/env tsx
/**
 * 抖音图床文件解码器
 *
 * 抖音 IM 加密图片（阅后即焚 msgType=91）的解密流程：
 *   1. 调用 GET /aweme/v1/web/im/read_once/detail 拿到 skey + large_url
 *   2. 下载 large_url 得到 AES-256-GCM 密文
 *   3. 用 skey 解密：
 *      - key   = skey (32 字节)
 *      - nonce = 密文前 12 字节
 *      - tag   = 密文末尾 16 字节
 *      - 密文  = 中间部分
 *   4. 解密结果是 WebP/JPEG/PNG 等标准图片
 *
 * 普通图片（msgType=27）不需要解密，但抖音 CDN 返回的 content-type 是
 * application/octet-stream，文件名带 .image 后缀，本脚本也会检测格式
 * 并用正确扩展名保存。
 *
 * 用法：
 *   # 直接给本地 .image 文件改名（普通图片）
 *   npx tsx scripts/decode-image.ts "C:\xxx\uploadv2_xxx.image"
 *
 *   # 给 URL + skey 解密加密图片
 *   npx tsx scripts/decode-image.ts --url "https://..." --skey 67022d...  -o ./out
 *
 *   # 完整流程：给 msg_id + conversation_short_id，自动调 read_once/detail
 *   npx tsx scripts/decode-image.ts --msg-id 7665003725995722289 --conv 7411135054795014695 -o ./out
 *
 *   # 批量本地文件
 *   npx tsx scripts/decode-image.ts a.image b.image c.webp
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_STORAGE_STATE } from '../src/config/paths.js';
import { loadFromStorageState } from '../src/auth/session.js';
import { envFromSession } from '../src/api/operations.js';
import { getReadOnceImage } from '../src/api/webapi.js';
import { DEFAULT_UA } from '../src/api/imapi.js';

/** 检测图片格式 */
function detectFormat(buf: Buffer): { ext: string; desc: string } | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', desc: 'JPEG' };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: 'png', desc: 'PNG' };
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50)
    return { ext: 'webp', desc: 'WebP' };
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { ext: 'gif', desc: 'GIF' };
  if (buf[0] === 0x42 && buf[1] === 0x4d) return { ext: 'bmp', desc: 'BMP' };
  return null;
}

/**
 * AES-256-GCM 解密抖音加密图片
 *
 * @param skeyHex skey 的 hex 字符串（read_once/detail 返回，64 字符 = 32 字节）
 * @param ciphertext 完整密文（含 nonce + 加密数据 + tag）
 * @returns 解密后的明文 Buffer
 */
function decryptDouyinImage(skeyHex: string, ciphertext: Buffer): Buffer {
  if (ciphertext.length < 28) {
    throw new Error(`密文太短 (${ciphertext.length} 字节)，至少需要 28 字节（12 nonce + 16 tag）`);
  }
  const key = Buffer.from(skeyHex, 'hex');
  if (key.length !== 32) {
    throw new Error(`skey 长度异常: ${key.length} 字节（应为 32）`);
  }
  const nonce = ciphertext.subarray(0, 12);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(12, ciphertext.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/** 下载 URL 内容 */
async function downloadUrl(url: string): Promise<Buffer> {
  const r = await fetch(url, {
    headers: { 'user-agent': DEFAULT_UA, referer: 'https://www.douyin.com/' },
  });
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

/** 保存为正确扩展名 */
async function saveWithCorrectExt(buf: Buffer, baseName: string, outDir: string): Promise<string> {
  const fmt = detectFormat(buf);
  const stem = baseName.replace(/\.[^.]+$/, '').replace(/[~:]/g, '_');
  await fs.mkdir(outDir, { recursive: true });
  if (!fmt) {
    // 无法识别格式，保留原始字节，用 .bin
    const outPath = path.join(outDir, `${stem}.bin`);
    await fs.writeFile(outPath, buf);
    const hex = buf.subarray(0, 16).toString('hex').match(/.{2}/g)!.join(' ');
    throw new Error(`无法识别格式 (前 16: ${hex})，已保存原始字节到 ${outPath}`);
  }
  const outPath = path.join(outDir, `${stem}.${fmt.ext}`);
  await fs.writeFile(outPath, buf);
  return outPath;
}

function parseArgs(argv: string[]) {
  const args = { url: '', skey: '', msgId: '', conv: '', out: '', files: [] as string[] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') args.url = argv[++i];
    else if (a === '--skey') args.skey = argv[++i];
    else if (a === '--msg-id') args.msgId = argv[++i];
    else if (a === '--conv') args.conv = argv[++i];
    else if (a === '-o' || a === '--out') args.out = argv[++i];
    else args.files.push(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (process.argv.length <= 2) {
    console.error(`用法:
  # 模式 1：完整流程（推荐）—— 自动调 read_once/detail 拿 skey 和 URL
  npx tsx scripts/decode-image.ts --msg-id <msg_id> --conv <conversation_short_id> [-o 输出目录]

  # 模式 2：已有 skey 和密文 URL
  npx tsx scripts/decode-image.ts --url <密文URL> --skey <64位hex> [-o 输出目录]

  # 模式 3：本地 .image 文件改名（普通图片，无需解密）
  npx tsx scripts/decode-image.ts <本地文件路径>... [-o 输出目录]`);
    process.exit(1);
  }

  const outDir = args.out ? path.resolve(args.out) : process.cwd();

  // 模式 1：完整流程
  if (args.msgId && args.conv) {
    console.log(`[模式 1] 调用 read_once/detail 获取解密信息...`);
    const session = await loadFromStorageState(DEFAULT_STORAGE_STATE);
    const env = envFromSession(session);
    const info = await getReadOnceImage(env, args.msgId, args.conv);
    if (!info) {
      console.error(`✗ 无法获取解密信息：消息可能已被查看过（read_once 只能查看一次）`);
      process.exit(2);
    }
    console.log(`  skey: ${info.skey}`);
    console.log(`  large_url: ${info.largeUrl.slice(0, 100)}...`);
    console.log(`  oid: ${info.oid}`);
    console.log(`  data_size: ${info.dataSize} 字节`);
    console.log(`\n下载密文...`);
    const ciphertext = await downloadUrl(info.largeUrl);
    console.log(`  密文: ${ciphertext.length} 字节`);
    console.log(`\nAES-256-GCM 解密...`);
    const plaintext = decryptDouyinImage(info.skey!, ciphertext);
    console.log(`  明文: ${plaintext.length} 字节`);
    const outPath = await saveWithCorrectExt(plaintext, info.oid || 'douyin_image', outDir);
    const fmt = detectFormat(plaintext);
    console.log(`\n★ 解密成功！格式: ${fmt?.desc} -> ${outPath}`);
    return;
  }

  // 模式 2：已有 skey 和 URL
  if (args.url && args.skey) {
    console.log(`[模式 2] 下载 + 解密`);
    console.log(`  URL: ${args.url.slice(0, 100)}...`);
    console.log(`  skey: ${args.skey}`);
    const ciphertext = await downloadUrl(args.url);
    console.log(`  密文: ${ciphertext.length} 字节`);
    const plaintext = decryptDouyinImage(args.skey, ciphertext);
    console.log(`  明文: ${plaintext.length} 字节`);
    const baseName = (() => {
      try { return path.basename(new URL(args.url).pathname); } catch { return 'douyin_image'; }
    })();
    const outPath = await saveWithCorrectExt(plaintext, baseName, outDir);
    const fmt = detectFormat(plaintext);
    console.log(`\n★ 解密成功！格式: ${fmt?.desc} -> ${outPath}`);
    return;
  }

  // 模式 3：批量本地文件或 URL（普通图片，无需解密，仅下载+识别格式）
  if (args.files.length > 0) {
    console.log(`[模式 3] 批量处理 (${args.files.length} 个)`);
    let ok = 0, fail = 0;
    for (const f of args.files) {
      try {
        let buf: Buffer;
        let baseName: string;
        if (/^https?:\/\//i.test(f)) {
          // URL：先下载
          process.stdout.write(`  下载: ${f.slice(0, 100)}... `);
          buf = await downloadUrl(f);
          try { baseName = path.basename(new URL(f).pathname); } catch { baseName = `douyin_${Date.now()}`; }
          process.stdout.write(`${buf.length} 字节\n`);
        } else {
          const abs = path.resolve(f);
          buf = await fs.readFile(abs);
          baseName = path.basename(abs);
        }
        const outPath = await saveWithCorrectExt(buf, baseName, outDir);
        const fmt = detectFormat(buf);
        console.log(`  ✓ ${fmt?.desc ?? '?'} -> ${outPath}`);
        ok++;
      } catch (e: any) {
        console.error(`  ✗ ${f}: ${e.message}`);
        fail++;
      }
    }
    console.log(`\n完成: 成功 ${ok} | 失败 ${fail}`);
    return;
  }

  console.error(`参数不足，使用 --help 查看用法`);
  process.exit(1);
}

main().catch((e) => {
  console.error(`\n✗ 失败:`, e);
  process.exit(1);
});
