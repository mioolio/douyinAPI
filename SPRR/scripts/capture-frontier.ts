/**
 * 抓包脚本：记录浏览器 Frontier WebSocket 所有收发帧
 *
 * 用法：
 *   npx tsx scripts/capture-frontier.ts [持续时间秒数，默认90]
 *
 * 流程：
 *   1. 启动浏览器，导航到 /chat
 *   2. 监听 frontier-im.douyin.com 的 WS 连接
 *   3. 记录所有发送和接收的帧（hex + 尝试解析）
 *   4. 持续运行指定时间（期间可用 sprr send 发消息触发推送）
 *   5. 保存到 data/capture/frontier-frames.json
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../src/utils/logger.js';
import { DATA_DIR } from '../src/config/paths.js';
import { parseFrontierFrame } from '../src/api/frontier.js';
import { parseFields, findField, readVarint, readString } from '../src/crypto/protobuf.js';

const log = createLogger('capture');
const durationSec = parseInt(process.argv[2] || '90', 10);

interface CapturedFrame {
  dir: 'send' | 'recv';
  time: string;
  timeMs: number;
  hex: string;
  bytes: number;
  parsed?: any;
  textAttempt?: string;
}

const frames: CapturedFrame[] = [];
let startTime = 0;

function bufToHex(buf: Buffer | ArrayBuffer): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b.toString('hex');
}

function tryParseFrame(buf: Buffer): any {
  const result: any = {};
  try {
    const fields = parseFields(buf);
    for (const f of fields) {
      const key = `f${f.field}`;
      if (f.wire === 0) {
        result[key] = `varint=${readVarint(f)}`;
      } else if (f.wire === 2) {
        const v = f.value as Buffer;
        // 尝试作为字符串
        const str = v.toString('utf-8');
        if (/^[\x20-\x7e]+$/.test(str) && str.length > 2) {
          result[key] = `str="${str}"`;
        } else {
          // 尝试作为 protobuf 嵌套解析
          try {
            const subFields = parseFields(v);
            if (subFields.length > 0) {
              const sub: any = {};
              for (const sf of subFields) {
                if (sf.wire === 0) sub[`f${sf.field}`] = `varint=${readVarint(sf)}`;
                else if (sf.wire === 2) {
                  const sv = sf.value as Buffer;
                  const sstr = sv.toString('utf-8');
                  if (/^[\x20-\x7e]+$/.test(sstr) && sstr.length > 1) sub[`f${sf.field}`] = `str="${sstr}"`;
                  else sub[`f${sf.field}`] = `bytes[${sv.length}]=${sv.subarray(0, 32).toString('hex')}...`;
                }
              }
              result[key] = `msg={${JSON.stringify(sub)}}`;
            } else {
              result[key] = `bytes[${v.length}]=${v.subarray(0, 32).toString('hex')}`;
            }
          } catch {
            result[key] = `bytes[${v.length}]=${v.subarray(0, 32).toString('hex')}`;
          }
        }
      }
    }
    // 尝试 frontier 标准解析
    const frontier = parseFrontierFrame(buf);
    if (frontier.payload || frontier.msgId) {
      result._frontier = frontier;
    }
  } catch (e) {
    result._error = String(e);
  }
  return result;
}

async function main() {
  const { chromium } = await import('playwright');
  const storageState = path.join('..', 'ccc', 'data', 'storageState.json');
  const absStorage = path.resolve(storageState);

  log.info(`抓包脚本启动，持续 ${durationSec} 秒`);
  log.info(`storageState: ${absStorage}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    storageState: absStorage,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1400, height: 900 },
    locale: 'zh-CN',
  });

  const page = await context.newPage();

  let frontierWs: any = null;

  page.on('websocket', (ws) => {
    const url = ws.url();
    log.info(`检测到 WS 连接: ${url.replace(/access_key=[^&]+/, 'access_key=<redacted>')}`);

    if (!url.includes('frontier-im.douyin.com')) return;

    frontierWs = ws;

    ws.on('framesent', (frame: any) => {
      const now = Date.now();
      // playwright frame 对象可能有 data / payload 属性，可能是 string 或 Buffer
      const raw = frame.data ?? frame.payload;
      if (raw == null) {
        log.info(`[SEND] +${now - startTime}ms frame 对象无 data/payload: ${JSON.stringify(frame)}`);
        return;
      }
      const buf = typeof raw === 'string' ? Buffer.from(raw, 'utf-8') : Buffer.from(raw as ArrayBuffer);
      const opcode = frame.opcode ?? (typeof raw === 'string' ? 1 : 2);
      const captured: CapturedFrame = {
        dir: 'send',
        time: new Date(now).toLocaleTimeString('zh-CN', { hour12: false }),
        timeMs: now - startTime,
        hex: buf.toString('hex'),
        bytes: buf.length,
      };
      if (opcode === 1) {
        captured.textAttempt = typeof raw === 'string' ? raw : buf.toString('utf-8');
      } else {
        captured.parsed = tryParseFrame(buf);
      }
      frames.push(captured);
      log.info(`[SEND] +${captured.timeMs}ms ${buf.length}B opcode=${opcode} hex=${buf.subarray(0, 64).toString('hex')}${buf.length > 64 ? '...' : ''}`);
    });

    ws.on('framereceived', (frame: any) => {
      const now = Date.now();
      const raw = frame.data ?? frame.payload;
      if (raw == null) {
        log.info(`[RECV] +${now - startTime}ms frame 对象无 data/payload: ${JSON.stringify(frame)}`);
        return;
      }
      const buf = typeof raw === 'string' ? Buffer.from(raw, 'utf-8') : Buffer.from(raw as ArrayBuffer);
      const opcode = frame.opcode ?? (typeof raw === 'string' ? 1 : 2);
      const captured: CapturedFrame = {
        dir: 'recv',
        time: new Date(now).toLocaleTimeString('zh-CN', { hour12: false }),
        timeMs: now - startTime,
        hex: buf.toString('hex'),
        bytes: buf.length,
      };
      if (opcode === 1) {
        captured.textAttempt = typeof raw === 'string' ? raw : buf.toString('utf-8');
      } else {
        captured.parsed = tryParseFrame(buf);
      }
      frames.push(captured);
      log.info(`[RECV] +${captured.timeMs}ms ${buf.length}B opcode=${opcode} hex=${buf.subarray(0, 64).toString('hex')}${buf.length > 64 ? '...' : ''}`);
    });

    ws.on('close', () => {
      log.info('Frontier WS 关闭');
    });
  });

  log.info('导航到 /chat ...');
  await page.goto('https://www.douyin.com/chat?isPopup=1', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });

  startTime = Date.now();
  log.info(`开始记录帧（持续 ${durationSec} 秒，期间可发消息触发推送）`);
  log.info('-'.repeat(80));

  // 等待指定时间
  await new Promise((resolve) => setTimeout(resolve, durationSec * 1000));

  log.info('-'.repeat(80));
  log.info(`抓包结束，共 ${frames.length} 帧`);

  // 保存到文件
  const captureDir = path.join(DATA_DIR, 'capture');
  await fs.mkdir(captureDir, { recursive: true });
  const outFile = path.join(captureDir, `frontier-frames-${Date.now()}.json`);
  await fs.writeFile(outFile, JSON.stringify(frames, null, 2), 'utf-8');
  log.info(`已保存到: ${outFile}`);

  // 统计
  const sentFrames = frames.filter((f) => f.dir === 'send');
  const recvFrames = frames.filter((f) => f.dir === 'recv');
  log.info(`发送: ${sentFrames.length} 帧`);
  log.info(`接收: ${recvFrames.length} 帧`);

  // 打印所有发送帧（关键：找握手/订阅帧）
  if (sentFrames.length > 0) {
    log.info('\n=== 所有发送帧（按时间顺序）===');
    for (const f of sentFrames) {
      log.info(`  +${f.timeMs}ms ${f.bytes}B: ${f.hex.slice(0, 128)}${f.hex.length > 128 ? '...' : ''}`);
      if (f.textAttempt) log.info(`    text: "${f.textAttempt}"`);
      if (f.parsed && Object.keys(f.parsed).length > 0) {
        log.info(`    parsed: ${JSON.stringify(f.parsed).slice(0, 200)}`);
      }
    }
  }

  // 打印前几条接收帧
  if (recvFrames.length > 0) {
    log.info('\n=== 前 10 条接收帧 ===');
    for (const f of recvFrames.slice(0, 10)) {
      log.info(`  +${f.timeMs}ms ${f.bytes}B: ${f.hex.slice(0, 128)}${f.hex.length > 128 ? '...' : ''}`);
      if (f.textAttempt) log.info(`    text: "${f.textAttempt}"`);
      if (f.parsed && Object.keys(f.parsed).length > 0) {
        log.info(`    parsed: ${JSON.stringify(f.parsed).slice(0, 200)}`);
      }
    }
  }

  await browser.close();
  process.exit(0);
}

main().catch((e) => {
  log.error('抓包失败', e);
  process.exit(1);
});
