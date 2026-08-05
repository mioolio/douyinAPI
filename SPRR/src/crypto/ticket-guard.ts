/**
 * bd-ticket-guard 浏览器加密签名头管理器
 *
 * 抓包分析结论（2026-07-26 interact 数据，3 个 comment_publish 样本对比）：
 *   - bd-ticket-guard-client-data / bd-ticket-guard-ree-public-key / x-tt-session-dtrait
 *     三个头在同一会话内对同一路径完全静态，浏览器生成后缓存复用；
 *   - ts_sign 来源于 cookie bd_ticket_guard_client_data_v2（会话级稳定）；
 *   - req_sign 按 path 缓存（同路径复用同一签名）；
 *   - x-tt-session-dtrait 会话级稳定，不随请求变化。
 *
 * 因此无需纯算逆向 ECDH + HMAC，只需从浏览器抓包一次，存入 data/ticket-guard.json，
 * 后续 comment 命令自动加载复用。会话失效（cookie 过期或风控）后重新抓包即可。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';
import { DATA_DIR } from '../config/paths.js';

const log = createLogger('ticket-guard');

/** ticket-guard 配置文件路径 */
const TICKET_GUARD_FILE = path.join(DATA_DIR, 'ticket-guard.json');

/** 抓包数据目录（interact 抓包脚本输出） */
const CAPTURE_DIR = path.join(DATA_DIR, 'capture', 'interact', 'requests');

/** ticket-guard 三头配置 */
export interface TicketGuardConfig {
  /** bd-ticket-guard-client-data 头值（base64 JSON） */
  clientData: string;
  /** bd-ticket-guard-ree-public-key 头值（base64 ECDH 公钥） */
  reePublicKey: string;
  /** x-tt-session-dtrait 头值 */
  sessionDtrait: string;
  /** 抓包时间（Unix 毫秒） */
  capturedAt: number;
  /** 来源描述（如 "capture:0075_POST_xxx" 或 "manual"） */
  capturedFrom: string;
}

/**
 * 从 data/ticket-guard.json 加载已保存的 ticket-guard 配置
 *
 * @returns 配置对象；文件不存在或解析失败返回 null
 */
export async function loadTicketGuard(): Promise<TicketGuardConfig | null> {
  try {
    const raw = await fs.readFile(TICKET_GUARD_FILE, 'utf-8');
    const cfg = JSON.parse(raw) as TicketGuardConfig;
    if (!cfg.clientData || !cfg.reePublicKey || !cfg.sessionDtrait) {
      log.warn('loadTicketGuard: 配置文件字段不完整');
      return null;
    }
    return cfg;
  } catch {
    return null;
  }
}

/**
 * 保存 ticket-guard 配置到 data/ticket-guard.json
 */
export async function saveTicketGuard(cfg: TicketGuardConfig): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(TICKET_GUARD_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
  log.info(`saveTicketGuard: 已保存到 ${TICKET_GUARD_FILE}`);
}

/**
 * 从抓包数据目录自动提取 ticket-guard 三头
 *
 * 扫描 data/capture/interact/requests/ 下的 *_POST_*comment_publish*.json 文件，
 * 按文件名索引降序（最新抓包）优先，提取三个头。
 *
 * @param captureDir 抓包目录（默认 data/capture/interact/requests/）
 * @returns 提取到的配置；无可用样本返回 null
 */
export async function extractTicketGuardFromCapture(
  captureDir: string = CAPTURE_DIR,
): Promise<TicketGuardConfig | null> {
  let files: string[];
  try {
    files = await fs.readdir(captureDir);
  } catch {
    log.warn(`extractTicketGuardFromCapture: 抓包目录不存在 ${captureDir}`);
    return null;
  }

  // 筛选 comment_publish 的 POST 请求文件，按文件名索引降序（最新优先）
  const publishFiles = files
    .filter((f) => f.includes('_POST_') && f.includes('comment_publish'))
    .sort()
    .reverse();

  if (publishFiles.length === 0) {
    log.warn('extractTicketGuardFromCapture: 未找到 comment_publish 抓包样本');
    return null;
  }

  for (const file of publishFiles) {
    const filePath = path.join(captureDir, file);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(raw) as {
        ts?: string;
        request?: {
          headers?: Record<string, string>;
        };
      };
      const headers = data.request?.headers || {};
      const clientData = headers['bd-ticket-guard-client-data'];
      const reePublicKey = headers['bd-ticket-guard-ree-public-key'];
      const sessionDtrait = headers['x-tt-session-dtrait'];

      if (clientData && reePublicKey && sessionDtrait) {
        const capturedAt = data.ts ? new Date(data.ts).getTime() : Date.now();
        log.info(
          `extractTicketGuardFromCapture: 从 ${file} 提取成功（clientData=${clientData.length}chars dtrait=${sessionDtrait.length}chars）`,
        );
        return {
          clientData,
          reePublicKey,
          sessionDtrait,
          capturedAt,
          capturedFrom: `capture:${file}`,
        };
      }
      log.debug(`extractTicketGuardFromCapture: ${file} 缺少完整三头，尝试下一个`);
    } catch (e) {
      log.debug(`extractTicketGuardFromCapture: 解析 ${file} 失败`, e);
    }
  }

  log.warn('extractTicketGuardFromCapture: 所有样本均缺少完整三头');
  return null;
}

/**
 * 检查 ticket-guard 配置是否可能已过期
 *
 * 抓包样本表明三头在会话内稳定，会话失效时间取决于 cookie 有效期。
 * 这里保守估计为 24 小时（与 sessionid 默认有效期一致）。
 *
 * @param cfg 配置对象
 * @param maxAgeMs 最大有效期（默认 24 小时）
 * @returns true 表示可能已过期，建议重新抓包
 */
export function isTicketGuardExpired(
  cfg: TicketGuardConfig,
  maxAgeMs: number = 24 * 60 * 60 * 1000,
): boolean {
  const age = Date.now() - cfg.capturedAt;
  return age > maxAgeMs;
}

/**
 * 加载 ticket-guard 配置，若不存在则尝试从抓包数据自动提取
 *
 * @param autoExtract true 时（默认）自动从抓包目录提取
 * @returns 配置对象；无可用配置返回 null
 */
export async function loadOrExtractTicketGuard(
  autoExtract: boolean = true,
): Promise<TicketGuardConfig | null> {
  // 1. 先尝试加载已保存的配置
  const saved = await loadTicketGuard();
  if (saved) {
    if (isTicketGuardExpired(saved)) {
      log.warn(
        `loadOrExtractTicketGuard: 已保存的配置可能已过期（抓包于 ${new Date(saved.capturedAt).toLocaleString('zh-CN', { hour12: false })}）`,
      );
    }
    return saved;
  }

  // 2. 自动从抓包数据提取
  if (autoExtract) {
    log.info('loadOrExtractTicketGuard: 未找到已保存配置，尝试从抓包数据自动提取...');
    const extracted = await extractTicketGuardFromCapture();
    if (extracted) {
      await saveTicketGuard(extracted);
      return extracted;
    }
  }

  return null;
}
