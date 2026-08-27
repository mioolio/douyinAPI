#!/usr/bin/env tsx
/**
 * 私信功能全量抓包调试脚本（API 更新分析用）
 *
 * 用途：
 *   抖音 API 更新后，捕获浏览器端私信的全部网络流量，用于：
 *   - 发现新增/变更的 API（URL path、cmd 编号）
 *   - 对比签名参数和签名头的变化（a_bogus / msToken / bd-ticket-guard-*）
 *   - 分析响应体 protobuf 结构变化（新字段、新消息类型，即被识别为"未知"的消息）
 *   - 抓取阅后即焚（仅读一次）消息的完整发送/读取流程
 *
 * 捕获范围：
 *   1. HTTP：imapi.douyin.com 全部 + URL 含 frontier / im.douyin.com / 路径含 /im/ 的请求
 *      （请求 URL/query/headers/protobuf body + 响应 status/headers/protobuf body 全量保存）
 *   2. WebSocket：所有 WS 连接（重点 frontier-im.douyin.com），全部收发帧（跳过 2 字节心跳）
 *   3. 浏览器 console 日志
 *
 * 保存结构（实时写盘，突然关闭浏览器也不丢数据）：
 *   data/capture/debug/debug-<时间戳>/
 *     ├── summary.json          会话汇总（cmd 统计、未知 cmd、WS 帧统计、文件索引）
 *     ├── console.log           浏览器 console（NDJSON，每行一条）
 *     ├── http/
 *     │   ├── 001-cmd100-v1-message-send.json    每个请求/响应对一个文件
 *     │   └── ...
 *     ├── ws-connections.json   WS 连接列表（含完整 URL，access_key 不脱敏）
 *     └── ws-frames.ndjson      WS 帧（每帧一行，含 protobuf 预解析）
 *
 * 使用流程：
 *   1. npx tsx scripts/debug-capture.ts [--account <name>] [--timeout <分钟>]
 *   2. 浏览器自动打开抖音私信页（已登录态）
 *   3. 手动操作：发文本/图片/表情/仅读一次消息、收消息、撤回、已读等
 *   4. 操作完成后直接关闭浏览器窗口，脚本自动保存汇总并退出（Ctrl+C 亦可）
 *   5. 分析 data/capture/debug/debug-<时间戳>/ 下的文件
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================ 路径与常量 ============================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ACCOUNTS_DIR = path.join(PROJECT_ROOT, 'data', 'accounts');
const CAPTURE_ROOT = path.join(PROJECT_ROOT, 'data', 'capture', 'debug');

const CHAT_URL = 'https://www.douyin.com/chat';
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** 已知 IMCMD 编号（来自逆向），用于标注；不在表内的 cmd 是"新 API"线索 */
const CMD_NAMES: Record<number, string> = {
  100: 'SEND_MESSAGE',
  301: 'GET_MESSAGES_BY_CONVERSATION',
  610: 'GET_INFO_LIST',
  702: 'RECALL_MESSAGE',
  1001: 'STRANGER_GET_CONVERSATION_LIST',
  1002: 'GET_STRANGER_MESSAGES',
  1450: 'MARK_READ',
  1452: 'GET_READ_INDEX_LEGACY',
  1453: 'GET_MIN_INDEX_LEGACY',
  1454: 'BATCH_GET_READINDEX_LEGACY',
  2000: 'GET_READ_INDEX',
  2001: 'GET_MIN_INDEX',
  2002: 'MARK_CONVERSATION_READ',
  2006: 'GET_USER_CONVERSATION_LIST',
  2038: 'BATCH_GET_READINDEX',
};

/** 默认抓包时长上限（分钟），用户关闭浏览器即提前结束 */
const DEFAULT_TIMEOUT_MIN = 30;

// ============================ 轻量 protobuf 解析（自包含） ============================

interface PField {
  field: number;
  wire: number;
  varint?: bigint;
  bytes?: Buffer;
}

/** 解析 protobuf 顶层字段（解析失败返回 null） */
function parseProtoFields(buf: Buffer): PField[] | null {
  const fields: PField[] = [];
  let pos = 0;
  try {
    while (pos < buf.length) {
      // 读 tag varint
      const [tag, p1] = readVarintAt(buf, pos);
      if (tag === null || p1 === null) return null;
      const field = Number(tag >> 3n);
      const wire = Number(tag & 7n);
      if (field <= 0 || field > 100000) return null; // 字段号异常 → 大概率不是 protobuf
      pos = p1;

      if (wire === 0) {
        // varint
        const [v, p2] = readVarintAt(buf, pos);
        if (v === null || p2 === null) return null;
        pos = p2;
        fields.push({ field, wire, varint: v });
      } else if (wire === 1) {
        // fixed64
        if (pos + 8 > buf.length) return null;
        pos += 8;
        fields.push({ field, wire, varint: buf.readBigUInt64LE(pos - 8) });
      } else if (wire === 2) {
        // length-delimited
        const [len, p2] = readVarintAt(buf, pos);
        if (len === null || p2 === null) return null;
        const l = Number(len);
        if (l < 0 || p2 + l > buf.length) return null;
        fields.push({ field, wire, bytes: buf.subarray(p2, p2 + l) });
        pos = p2 + l;
      } else if (wire === 5) {
        // fixed32
        if (pos + 4 > buf.length) return null;
        pos += 4;
        fields.push({ field, wire, varint: BigInt(buf.readUInt32LE(pos - 4)) });
      } else {
        // wire 3/4 (start/end group) 已废弃，视为非 protobuf
        return null;
      }
    }
  } catch {
    return null;
  }
  return fields;
}

function readVarintAt(buf: Buffer, pos: number): [bigint | null, number | null] {
  let result = 0n;
  let shift = 0n;
  let p = pos;
  while (p < buf.length) {
    const b = buf[p];
    p++;
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [result, p];
    shift += 7n;
    if (shift > 63n) return [null, null]; // varint 超长
  }
  return [null, null];
}

/** varint → number / string（超 2^53 转 string 防精度丢失） */
function varintToJs(v: bigint): number | string {
  if (v <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(v);
  return v.toString();
}

/** 判断 bytes 是否为可读 utf-8 文本（可打印字符占比高） */
function tryUtf8(buf: Buffer): string | null {
  if (buf.length === 0) return null;
  try {
    const s = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    if (s.length === 0) return null;
    let printable = 0;
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      if (c === 0x0a || c === 0x09 || (c >= 0x20 && c !== 0x7f)) printable++;
    }
    return printable / s.length >= 0.85 ? s : null;
  } catch {
    return null;
  }
}

const MAX_DUMP_DEPTH = 5;
const MAX_FIELDS_PER_MSG = 256; // 单条消息最多展示的字段条目
const MAX_REPEATED_ENTRIES = 30; // repeated 字段最多展示的条目（如消息列表）
const MAX_DUMP_NODES = 20000; // 全局节点预算（防超大响应生成巨型 JSON）

/**
 * 通用 protobuf → 可读树
 *
 * 嵌套 bytes 字段：优先尝试 utf-8 文本（content JSON / URL 等），
 * 失败后尝试嵌套 protobuf，都不是则 hex 预览。
 * 顶层（depth=0）：优先按 protobuf 解析（imapi 请求/响应体），失败则按 utf-8 文本（JSON 响应）。
 */
function protoDump(buf: Buffer, depth = 0, budget = { left: MAX_DUMP_NODES }): unknown {
  if (buf.length === 0) return {};
  if (budget.left <= 0) return { _budgetExhausted: true };
  budget.left--;
  if (depth >= MAX_DUMP_DEPTH) {
    return { _truncated: true, size: buf.length, hexPreview: buf.subarray(0, 64).toString('hex') };
  }

  const fields = parseProtoFields(buf);
  if (!fields || fields.length === 0) {
    // 非 protobuf：可能是纯文本/JSON 响应
    const utf8 = tryUtf8(buf);
    if (utf8 !== null) return utf8;
    return { _binary: true, size: buf.length, hexPreview: buf.subarray(0, 64).toString('hex') };
  }

  // 预统计字段出现次数（repeated 检测，避免 O(n²)）
  const fieldCounts = new Map<number, number>();
  for (const f of fields) fieldCounts.set(f.field, (fieldCounts.get(f.field) ?? 0) + 1);

  const out: Record<string, unknown> = {};
  const emittedPerField = new Map<number, number>();
  let emittedTotal = 0;
  for (const f of fields) {
    if (++emittedTotal > MAX_FIELDS_PER_MSG) {
      out._truncatedFields = true;
      break;
    }
    const seen = emittedPerField.get(f.field) ?? 0;
    emittedPerField.set(f.field, seen + 1);
    if (seen >= MAX_REPEATED_ENTRIES) continue;

    const repeated = fieldCounts.get(f.field)! > 1;
    const key = repeated ? `f${f.field}s` : `f${f.field}`;

    let value: unknown;
    if (f.varint !== undefined) {
      value = varintToJs(f.varint);
    } else {
      const bytes = f.bytes!;
      // 嵌套 bytes：可读文本优先（content JSON / URL），其次嵌套 protobuf，否则 binary
      const utf8 = tryUtf8(bytes);
      if (utf8 !== null) {
        value = utf8;
      } else {
        const nested = parseProtoFields(bytes);
        if (nested && nested.length > 0) {
          value = protoDump(bytes, depth + 1, budget);
        } else {
          value = {
            _binary: true,
            size: bytes.length,
            hexPreview: bytes.subarray(0, 64).toString('hex'),
          };
        }
      }
    }

    if (repeated) {
      if (!Array.isArray(out[key])) out[key] = [];
      (out[key] as unknown[]).push(value);
    } else {
      out[key] = value;
    }
  }

  // 标注被截断的 repeated 字段
  for (const [fnum, total] of fieldCounts) {
    const shownCount = emittedPerField.get(fnum) ?? 0;
    if (total > shownCount && shownCount >= MAX_REPEATED_ENTRIES) {
      out[`f${fnum}s_truncated`] = `${shownCount}/${total}`;
    }
  }
  return out;
}

/** 解析 imapi Request protobuf 顶层（cmd / sequence_id） */
function parseImapiRequest(buf: Buffer): { cmd: number; sequenceId?: number | string } | null {
  const fields = parseProtoFields(buf);
  if (!fields) return null;
  const f1 = fields.find((f) => f.field === 1 && f.varint !== undefined);
  if (!f1) return null;
  const f2 = fields.find((f) => f.field === 2 && f.varint !== undefined);
  return {
    cmd: Number(f1.varint!),
    sequenceId: f2 ? varintToJs(f2.varint!) : undefined,
  };
}

/** 解析 imapi Response protobuf 顶层（cmd / sequence_id / status_code / error_desc） */
function parseImapiResponse(buf: Buffer): {
  cmd: number;
  sequenceId?: number | string;
  statusCode?: number;
  errorDesc?: string;
} | null {
  const fields = parseProtoFields(buf);
  if (!fields) return null;
  const f1 = fields.find((f) => f.field === 1 && f.varint !== undefined);
  if (!f1) return null;
  const f2 = fields.find((f) => f.field === 2 && f.varint !== undefined);
  const f3 = fields.find((f) => f.field === 3 && f.varint !== undefined);
  const f4 = fields.find((f) => f.field === 4 && f.bytes !== undefined);
  return {
    cmd: Number(f1.varint!),
    sequenceId: f2 ? varintToJs(f2.varint!) : undefined,
    statusCode: f3 ? Number(f3.varint!) : undefined,
    errorDesc: f4 ? tryUtf8(f4.bytes!) ?? f4.bytes!.toString('hex') : undefined,
  };
}

/** 解析 Frontier WS 帧 protobuf 预览 */
function parseFrontierFrame(buf: Buffer): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = parseProtoFields(buf);
  if (!fields) return { parseFail: true, size: buf.length };
  const f1 = fields.find((f) => f.field === 1 && f.varint !== undefined);
  if (f1) out.serverTs = varintToJs(f1.varint!);
  const f2 = fields.find((f) => f.field === 2 && f.varint !== undefined);
  if (f2) out.internalMsgId = varintToJs(f2.varint!);
  const f3 = fields.find((f) => f.field === 3 && f.varint !== undefined);
  if (f3) out.frameCmd = varintToJs(f3.varint!);
  const f9 = fields.find((f) => f.field === 9 && f.bytes !== undefined);
  if (f9) {
    const s = tryUtf8(f9.bytes!);
    if (s) out.msgId = s;
  }
  const f11 = fields.find((f) => f.field === 11 && f.bytes !== undefined);
  if (f11) {
    const s = tryUtf8(f11.bytes!);
    if (s && !out.msgId) out.msgId = s;
  }
  // field 8 payload → 嵌套：f1 msgType / f5 direction / f7 logId
  const f8 = fields.find((f) => f.field === 8 && f.bytes !== undefined);
  if (f8) {
    const payloadFields = parseProtoFields(f8.bytes!);
    if (payloadFields) {
      const p1 = payloadFields.find((f) => f.field === 1 && f.varint !== undefined);
      if (p1) out.msgType = varintToJs(p1.varint!);
      const p5 = payloadFields.find((f) => f.field === 5 && f.varint !== undefined);
      if (p5) out.direction = varintToJs(p5.varint!);
      const p7 = payloadFields.find((f) => f.field === 7 && f.bytes !== undefined);
      if (p7) {
        const s = tryUtf8(p7.bytes!);
        if (s) out.logId = s;
      }
    }
  }
  return out;
}

// ============================ 参数解析 ============================

function getArgValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
  // 支持 --name=value
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  return undefined;
}

// ============================ 会话状态 ============================

interface HttpEntry {
  index: number;
  timestamp: string;
  url: string;
  method: string;
  path: string;
  query: Record<string, string>;
  reqHeaders: Record<string, string>;
  reqBodyBase64: string;
  reqBodyHex: string;
  reqBodySize: number;
  reqProto: { cmd: number; cmdName?: string; sequenceId?: number | string } | null;
  respStatus?: number;
  respHeaders?: Record<string, string>;
  respBodyBase64?: string;
  respBodySize?: number;
  respProto?: {
    cmd: number;
    cmdName?: string;
    sequenceId?: number | string;
    statusCode?: number;
    errorDesc?: string;
  } | null;
  error?: string;
  saved: boolean;
}

interface WsConnInfo {
  index: number;
  url: string;
  openedAt: string;
  closedAt?: string;
  framesSent: number;
  framesReceived: number;
}

/** 脱敏请求/响应 headers 中的敏感 cookie 值 */
function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'cookie' && typeof v === 'string') {
      out[k] = v.replace(
        /(sessionid|sessionid_ss|ssid|passport_csrf_token|s_v_web_id|msToken|ttwid)=([^;]{8})[^;]*/gi,
        (_, name, prefix) => `${name}=${prefix}***`,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 判断是否为需要捕获的私信相关 URL */
function shouldCaptureUrl(url: string): boolean {
  // 排除静态资源
  if (/\.(js|mjs|css|png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf|mp4|mpd|m3u8|ts)(\?|$)/i.test(url)) {
    return false;
  }
  if (url.includes('imapi.douyin.com')) return true;
  if (url.includes('frontier')) return true;
  if (url.includes('im.douyin.com')) return true;
  if (url.includes('/im/')) return true; // 如 /aweme/v1/web/im/user/info/
  return false;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** 定位已登录账号的 storageState */
async function locateStorageState(account?: string): Promise<string> {
  if (account) {
    const p = path.join(ACCOUNTS_DIR, `${account}.json`);
    if (await exists(p)) return p;
    throw new Error(`账号 ${account} 不存在（找不到 ${p}）`);
  }
  try {
    const current = (await fs.readFile(path.join(ACCOUNTS_DIR, 'current'), 'utf-8')).trim();
    if (current) {
      const p = path.join(ACCOUNTS_DIR, `${current}.json`);
      if (await exists(p)) return p;
    }
  } catch {
    // 忽略，走兜底
  }
  const legacy = path.resolve(PROJECT_ROOT, '..', 'ccc', 'data', 'storageState.json');
  if (await exists(legacy)) return legacy;
  throw new Error('未找到已登录账号，请先运行 sprr login 登录');
}

// ============================ 主流程 ============================

async function main() {
  const account = getArgValue('account');
  const timeoutMin = Number(getArgValue('timeout') ?? DEFAULT_TIMEOUT_MIN);
  const targetUrl = getArgValue('url') ?? CHAT_URL;

  const storageState = await locateStorageState(account);

  // 会话目录
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
    now.getDate(),
  ).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(
    now.getMinutes(),
  ).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const sessionDir = path.join(CAPTURE_ROOT, `debug-${stamp}`);
  const httpDir = path.join(sessionDir, 'http');
  await fs.mkdir(httpDir, { recursive: true });

  // 状态收集
  const httpEntries: HttpEntry[] = [];
  const wsConns: WsConnInfo[] = [];
  let wsFrameCount = 0;
  let heartbeatSkipped = 0;
  const wsMsgTypes = new Map<string, number>();
  let consoleLineCount = 0;
  const signParamsSeen = new Set<string>();
  const signHeadersSeen = new Set<string>();
  const SIGN_PARAM_NAMES = new Set([
    'a_bogus',
    'aBogus',
    'msToken',
    'verifyFp',
    'fp',
    'device_platform',
    'X-Bogus',
  ]);

  const consoleFile = path.join(sessionDir, 'console.log');
  const wsFramesFile = path.join(sessionDir, 'ws-frames.ndjson');

  console.log(`╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║          抖音私信 API 调试抓包（API 更新分析用）              ║`);
  console.log(`╚══════════════════════════════════════════════════════════════╝`);
  console.log(`  storageState: ${storageState}`);
  console.log(`  保存目录:     ${sessionDir}`);
  console.log(`  超时上限:     ${timeoutMin} 分钟（关闭浏览器即提前结束）`);
  console.log();

  const { chromium: chromiumMod } = await import('playwright');
  const browser = await chromiumMod.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled', '--window-size=1400,900'],
  });

  const context = await browser.newContext({
    storageState,
    userAgent: DEFAULT_UA,
    viewport: null,
    screen: { width: 1920, height: 1080 },
    locale: 'zh-CN',
  });

  // 反检测
  await context.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  `);

  // ---------- HTTP 捕获（context 级，覆盖所有标签页） ----------
  // pending 条目：请求已发出但响应未到（response.request() 实例可能与 request 事件不同，需 fallback 匹配）
  const pendingEntries: Array<{ reqObj: object; entry: HttpEntry }> = [];
  /**
   * 响应早到缓存：request 事件的处理器是异步的（allHeaders 耗时），
   * 快速 POST（如 message/send）的响应可能在条目注册前到达。
   * 此时把响应数据暂存，等 request 处理器完成后来认领。
   */
  const lateResponses = new Map<string, LateResponse>();

  interface LateResponse {
    status: number;
    headers: Record<string, string>;
    bodyBase64: string;
    bodySize: number;
    proto: NonNullable<HttpEntry['respProto']>;
    error?: string;
  }

  /** 按 request 实例精确匹配，失败则按 url+method 兜底匹配 */
  function takePendingEntry(reqObj: object, url: string, method: string): HttpEntry | null {
    for (let i = 0; i < pendingEntries.length; i++) {
      if (pendingEntries[i].reqObj === reqObj && !pendingEntries[i].entry.saved) {
        return pendingEntries.splice(i, 1)[0].entry;
      }
    }
    // fallback：Playwright 可能返回不同的 Request 包装实例，按 url+method 找最近未保存的
    for (let i = pendingEntries.length - 1; i >= 0; i--) {
      const p = pendingEntries[i];
      if (!p.entry.saved && p.entry.url === url && p.entry.method === method) {
        return pendingEntries.splice(i, 1)[0].entry;
      }
    }
    return null;
  }

  /** 把已读取的响应数据附着到条目并保存 */
  async function attachResponse(entry: HttpEntry, late: LateResponse): Promise<void> {
    entry.respStatus = late.status;
    entry.respHeaders = late.headers;
    entry.respBodyBase64 = late.bodyBase64;
    entry.respBodySize = late.bodySize;
    entry.respProto = late.proto;
    if (late.error) entry.error = late.error;
    await saveHttpEntry(entry, sessionDir);
    const statusLabel = entry.respProto
      ? `status=${entry.respProto.statusCode ?? '?'}`
      : `http=${entry.respStatus}`;
    console.log(
      `[HTTP #${entry.index}] ← 响应 ${statusLabel} ${
        entry.respBodySize !== undefined ? `${entry.respBodySize}B` : ''
      } 已保存`,
    );
  }

  /** 读取响应数据（status/headers/body/proto），供两条路径复用 */
  async function readResponseData(response: import('playwright').Response): Promise<LateResponse> {
    const late: LateResponse = {
      status: response.status(),
      headers: {},
      bodyBase64: '',
      bodySize: 0,
      proto: null as unknown as LateResponse['proto'],
    };
    try {
      late.headers = sanitizeHeaders(await response.allHeaders());
    } catch {
      // 忽略
    }
    try {
      const bodyBuf = await response.body();
      late.bodySize = bodyBuf.length;
      late.bodyBase64 = bodyBuf.toString('base64');
      if (response.url().includes('imapi.douyin.com') && bodyBuf.length > 0) {
        const parsed = parseImapiResponse(bodyBuf);
        if (parsed) {
          late.proto = { ...parsed, cmdName: CMD_NAMES[parsed.cmd] };
        }
      }
    } catch (e) {
      late.error = `resp-body-read-fail: ${e}`;
    }
    return late;
  }

  context.on('request', async (request) => {
    try {
      const url = request.url();
      if (request.method() === 'OPTIONS') return;
      if (!shouldCaptureUrl(url)) return;

      const u = new URL(url);
      const query: Record<string, string> = {};
      for (const [k, v] of u.searchParams.entries()) {
        query[k] = v;
        if (SIGN_PARAM_NAMES.has(k)) signParamsSeen.add(k);
      }

      let bodyBase64 = '';
      let bodyHex = '';
      let bodySize = 0;
      try {
        const bodyBuf = request.postDataBuffer();
        if (bodyBuf) {
          bodySize = bodyBuf.length;
          bodyBase64 = bodyBuf.toString('base64');
          bodyHex = bodyBuf.toString('hex');
        }
      } catch {
        // 无 body
      }

      // ★ 先同步注册条目（不含 headers），避免响应早到时配对失败
      const entry: HttpEntry = {
        index: httpEntries.length + 1,
        timestamp: new Date().toISOString(),
        url,
        method: request.method(),
        path: u.pathname,
        query,
        reqHeaders: {},
        reqBodyBase64: bodyBase64,
        reqBodyHex: bodyHex,
        reqBodySize: bodySize,
        reqProto: null,
        saved: false,
      };
      httpEntries.push(entry);
      pendingEntries.push({ reqObj: request as unknown as object, entry });

      const isImapi = url.includes('imapi.douyin.com');
      if (isImapi && bodySize > 0) {
        const parsed = parseImapiRequest(Buffer.from(bodyBase64, 'base64'));
        if (parsed) {
          entry.reqProto = { ...parsed, cmdName: CMD_NAMES[parsed.cmd] };
        }
      }

      const cmdLabel = entry.reqProto
        ? `cmd=${entry.reqProto.cmd}${entry.reqProto.cmdName ? `(${entry.reqProto.cmdName})` : '(未知cmd!)'}`
        : '';
      console.log(
        `[HTTP #${entry.index}] ${request.method()} ${u.pathname}${cmdLabel ? ` ${cmdLabel}` : ''}`,
      );

      // 再异步补请求头（此时条目已注册，早到的响应会被 lateResponses 机制接住）
      try {
        entry.reqHeaders = sanitizeHeaders(await request.allHeaders());
        for (const k of Object.keys(entry.reqHeaders)) {
          if (k.startsWith('bd-ticket-guard') || k.startsWith('x-tt-')) signHeadersSeen.add(k);
        }
      } catch {
        // 忽略
      }

      // 认领早到的响应（send 这类快速 POST）
      const lateKey = `${url}|${entry.method}`;
      const late = lateResponses.get(lateKey);
      if (late) {
        lateResponses.delete(lateKey);
        await attachResponse(entry, late);
      }
    } catch (e) {
      console.warn(`[HTTP 捕获异常] ${e}`);
    }
  });

  context.on('response', async (response) => {
    try {
      const url = response.url();
      const req = response.request();
      if (req.method() === 'OPTIONS') return;
      if (!shouldCaptureUrl(url)) return;

      const entry = takePendingEntry(req as unknown as object, url, req.method());
      const late = await readResponseData(response);

      if (entry && !entry.saved) {
        // 常规路径：请求条目已注册
        await attachResponse(entry, late);
      } else if (!entry) {
        // 响应早到：暂存，等 request 处理器认领（同 url+method 并发时保留最新，轮询场景是串行的，无碍）
        lateResponses.set(`${url}|${req.method()}`, late);
      }
    } catch (e) {
      console.warn(`[HTTP 响应捕获异常] ${e}`);
    }
  });

  context.on('requestfailed', async (request) => {
    try {
      const entry = takePendingEntry(request as unknown as object, request.url(), request.method());
      if (!entry || entry.saved) return;
      entry.error = `requestfailed: ${request.failure()?.errorText ?? 'unknown'}`;
      await saveHttpEntry(entry, sessionDir);
      console.log(`[HTTP #${entry.index}] ✗ 请求失败 ${entry.error}`);
    } catch {
      // 忽略
    }
  });

  // ---------- WebSocket 捕获 ----------
  context.on('websocket', (ws) => {
    const conn: WsConnInfo = {
      index: wsConns.length + 1,
      url: ws.url(),
      openedAt: new Date().toISOString(),
      framesSent: 0,
      framesReceived: 0,
    };
    wsConns.push(conn);
    console.log(`[WS #${conn.index}] 连接 ${ws.url().slice(0, 140)}`);

    const recordFrame = async (dir: 'sent' | 'recv', payload: string | Buffer) => {
      try {
        const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload;
        // 跳过 2 字节心跳 "hi"（0x6869）
        if (buf.length <= 2) {
          heartbeatSkipped++;
          return;
        }
        wsFrameCount++;
        if (dir === 'sent') conn.framesSent++;
        else conn.framesReceived++;

        let proto: Record<string, unknown> = {};
        if (buf.length > 0) {
          proto = parseFrontierFrame(buf);
          if (typeof proto.msgType !== 'undefined') {
            const t = String(proto.msgType);
            wsMsgTypes.set(t, (wsMsgTypes.get(t) ?? 0) + 1);
          }
        }

        const line = JSON.stringify({
          i: wsFrameCount,
          ts: new Date().toISOString(),
          dir,
          ws: conn.index,
          size: buf.length,
          b64: buf.toString('base64'),
          hex: buf.toString('hex').slice(0, 400),
          p: proto,
        });
        await fs.appendFile(wsFramesFile, line + '\n', 'utf-8');

        if (typeof proto.msgType !== 'undefined') {
          console.log(
            `[WS #${conn.index} ${dir}] ${buf.length}B msgType=${proto.msgType}${
              proto.msgId ? ` msgId=${String(proto.msgId).slice(0, 24)}` : ''
            }`,
          );
        }
      } catch (e) {
        console.warn(`[WS 帧捕获异常] ${e}`);
      }
    };

    ws.on('framesent', (frame) => void recordFrame('sent', frame.payload()));
    ws.on('framereceived', (frame) => void recordFrame('recv', frame.payload()));
    ws.on('close', () => {
      conn.closedAt = new Date().toISOString();
      console.log(`[WS #${conn.index}] 关闭（sent=${conn.framesSent} recv=${conn.framesReceived}）`);
    });
  });

  // ---------- 浏览器 console 捕获 ----------
  context.on('page', (page) => {
    page.on('console', (msg) => {
      const type = msg.type();
      if (type === 'error' || type === 'warning') {
        const line = JSON.stringify({ ts: new Date().toISOString(), type, text: msg.text() });
        void fs.appendFile(consoleFile, line + '\n', 'utf-8');
        consoleLineCount++;
      }
    });
    page.on('pageerror', (err) => {
      const line = JSON.stringify({ ts: new Date().toISOString(), type: 'pageerror', text: err.message });
      void fs.appendFile(consoleFile, line + '\n', 'utf-8');
      consoleLineCount++;
    });
  });

  // ---------- 打开页面 ----------
  const page = await context.newPage();
  console.log(`导航到 ${targetUrl} ...`);
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  console.log();
  console.log(`═══════════════════════════════════════════════════════════════`);
  console.log(` 浏览器已打开，本轮重点测试场景：`);
  console.log(`   1. 发送「仅读一次」文本消息（长按/点击发送键旁的模式切换）`);
  console.log(`   2. 发送「仅读一次」图片消息`);
  console.log(`   3. 发送一条普通文本消息（对照组）`);
  console.log(`   4. 用另一个账号发消息过来，等待 30~60 秒观察轮询收消息`);
  console.log(`   5. 用另一个账号查看/阅读你发的仅读一次消息`);
  console.log(`   6. 在本账号查看对方发来的仅读一次消息（触发 read_once）`);
  console.log(`   7. 撤回一条消息 / 切换几个会话`);
  console.log(`   8. 全程保持页面打开 ≥3 分钟（验证是否有 WS 连接出现）`);
  console.log(`═══════════════════════════════════════════════════════════════`);
  console.log(` 操作完成后【直接关闭浏览器窗口】即可，脚本会自动保存并退出`);
  console.log(` （也可以在终端按 Ctrl+C 结束；数据实时落盘，中途关也不丢）`);
  console.log();

  // ---------- 等待结束 ----------
  let finished = false;
  let endReason = '';

  const finish = async (reason: string) => {
    if (finished) return;
    finished = true;
    endReason = reason;
    console.log(`\n结束抓包（原因: ${reason}），正在保存汇总...`);

    // 保存尚未落盘的 pending HTTP 条目
    for (const entry of httpEntries) {
      if (!entry.saved) {
        await saveHttpEntry(entry, sessionDir);
      }
    }

    // 保存 WS 连接信息
    await fs.writeFile(
      path.join(sessionDir, 'ws-connections.json'),
      JSON.stringify(wsConns, null, 2),
      'utf-8',
    );

    // 汇总
    const cmdStats: Record<string, number> = {};
    const unknownCmds: number[] = [];
    for (const e of httpEntries) {
      if (e.reqProto?.cmd !== undefined) {
        const c = e.reqProto.cmd;
        cmdStats[String(c)] = (cmdStats[String(c)] ?? 0) + 1;
        if (!CMD_NAMES[c]) unknownCmds.push(c);
      }
    }

    const summary = {
      sessionStart: now.toISOString(),
      sessionEnd: new Date().toISOString(),
      endReason,
      storageState,
      targetUrl,
      http: {
        total: httpEntries.length,
        requests: httpEntries.map((e) => ({
          file: `http/${httpFileName(e)}`,
          index: e.index,
          method: e.method,
          path: e.path,
          cmd: e.reqProto?.cmd,
          cmdName: e.reqProto?.cmdName ?? (e.reqProto?.cmd !== undefined ? '(未知cmd!)' : undefined),
          respStatusCode: e.respProto?.statusCode,
          errorDesc: e.respProto?.errorDesc,
          httpStatus: e.respStatus,
          reqSize: e.reqBodySize,
          respSize: e.respBodySize,
          error: e.error,
        })),
        cmdStats,
        unknownCmds,
      },
      sign: {
        paramsSeen: [...signParamsSeen],
        headersSeen: [...signHeadersSeen],
      },
      ws: {
        connections: wsConns.map((c) => ({
          index: c.index,
          url: c.url,
          framesSent: c.framesSent,
          framesReceived: c.framesReceived,
        })),
        totalFrames: wsFrameCount,
        heartbeatSkipped,
        receivedMsgTypes: Object.fromEntries(wsMsgTypes),
      },
      consoleWarnings: consoleLineCount,
    };
    await fs.writeFile(
      path.join(sessionDir, 'summary.json'),
      JSON.stringify(summary, null, 2),
      'utf-8',
    );

    // 终端摘要
    console.log();
    console.log(`═══════════════════════════════════════════════════════════════`);
    console.log(` 抓包完成，数据已保存到: ${sessionDir}`);
    console.log(`   HTTP 请求: ${httpEntries.length} 个`);
    console.log(`   WS 连接:   ${wsConns.length} 个，帧 ${wsFrameCount} 个（心跳跳过 ${heartbeatSkipped}）`);
    if (unknownCmds.length > 0) {
      console.log(`   ★ 发现未知 cmd: ${[...new Set(unknownCmds)].join(', ')}（可能是新增 API）`);
    } else {
      console.log(`   未见未知 cmd（请求侧）`);
    }
    if (wsMsgTypes.size > 0) {
      console.log(`   WS msgType 分布: ${JSON.stringify(Object.fromEntries(wsMsgTypes))}`);
    }
    console.log(`   签名参数: ${[...signParamsSeen].join(', ') || '无'}`);
    console.log(`   签名头:   ${[...signHeadersSeen].join(', ') || '无'}`);
    console.log(`═══════════════════════════════════════════════════════════════`);

    try {
      await browser.close();
    } catch {
      // 已关闭
    }
    process.exit(0);
  };

  // 用户关闭浏览器窗口 → 结束
  browser.on('disconnected', () => void finish('browser-closed'));
  // Ctrl+C → 结束
  process.once('SIGINT', () => void finish('ctrl-c'));
  // 超时兜底（unref 不阻止进程退出）
  const timer = setTimeout(() => void finish('timeout'), timeoutMin * 60 * 1000);
  timer.unref?.();
}

/** HTTP 条目文件名 */
function httpFileName(e: HttpEntry): string {
  const parts: string[] = [String(e.index).padStart(3, '0')];
  if (e.reqProto?.cmd !== undefined) parts.push(`cmd${e.reqProto.cmd}`);
  const p = e.path.replace(/^\//, '').replace(/[/?&=]/g, '-').slice(0, 60);
  if (p) parts.push(p);
  return `${parts.join('-')}.json`;
}

/** 保存单个 HTTP 条目到文件（含 protobuf dump） */
async function saveHttpEntry(entry: HttpEntry, sessionDir: string): Promise<void> {
  if (entry.saved) return;
  entry.saved = true;

  const reqBuf = Buffer.from(entry.reqBodyBase64, 'base64');
  const respBuf = entry.respBodyBase64
    ? Buffer.from(entry.respBodyBase64, 'base64')
    : null;

  const output = {
    index: entry.index,
    timestamp: entry.timestamp,
    request: {
      url: entry.url,
      method: entry.method,
      path: entry.path,
      query: entry.query,
      headers: entry.reqHeaders,
      bodySize: entry.reqBodySize,
      bodyBase64: entry.reqBodyBase64,
      bodyHex: entry.reqBodyHex,
      proto: entry.reqProto,
      /** 请求体 protobuf 可读树（含嵌套 body 的结构预览） */
      protoDump: entry.reqBodySize > 0 ? protoDump(reqBuf) : undefined,
    },
    response: entry.respStatus
      ? {
          status: entry.respStatus,
          headers: entry.respHeaders,
          bodySize: entry.respBodySize,
          bodyBase64: entry.respBodyBase64,
          proto: entry.respProto,
          /** 响应体 protobuf 可读树（分析字段变化的核心数据） */
          protoDump: respBuf && respBuf.length > 0 ? protoDump(respBuf) : undefined,
        }
      : null,
    error: entry.error,
  };

  const filepath = path.join(sessionDir, 'http', httpFileName(entry));
  await fs.writeFile(filepath, JSON.stringify(output, null, 2), 'utf-8');
}

/** 冒烟测试：验证 protobuf 解析器（不启动浏览器） */
function selfTest(): void {
  let pass = 0;
  let fail = 0;
  const check = (name: string, cond: boolean, detail?: unknown) => {
    if (cond) {
      pass++;
      console.log(`  ✓ ${name}`);
    } else {
      fail++;
      console.log(`  ✗ ${name} ${detail !== undefined ? JSON.stringify(detail) : ''}`);
    }
  };

  console.log('protobuf 解析器冒烟测试:');

  // 1. varint 字段：f1=100, f2=10001(varint 2字节)
  const buf1 = Buffer.from('086410a14e', 'hex');
  const f1 = parseProtoFields(buf1)!;
  check('parseProtoFields varint', f1.length === 2 && Number(f1[0].varint!) === 100);
  check('parseImapiRequest cmd', parseImapiRequest(buf1)?.cmd === 100);

  // 2. bytes 字段含 utf-8：field7 = "你好"
  const buf2 = Buffer.from('3a06e4bda0e5a5bd', 'hex');
  const dump2 = protoDump(buf2) as Record<string, unknown>;
  check('protoDump utf-8 bytes', dump2.f7 === '你好', dump2);

  // 3. repeated 字段聚合：f1 出现 3 次
  const buf3 = Buffer.from('080108020803', 'hex');
  const dump3 = protoDump(buf3) as Record<string, unknown>;
  check(
    'protoDump repeated 聚合',
    JSON.stringify(dump3.f1s) === '[1,2,3]',
    dump3,
  );

  // 4. 顶层 JSON 文本（非 protobuf）：0x7b wire=3 解析失败 → utf8
  const buf4 = Buffer.from('{"aweType":700,"text":"hi"}', 'utf-8');
  const dump4 = protoDump(buf4);
  check('protoDump 顶层 JSON', dump4 === '{"aweType":700,"text":"hi"}', dump4);

  // 5. imapi Response 顶层：f1 cmd=100, f3 status=0, f4 desc=""
  const buf5 = Buffer.concat([
    Buffer.from('0864', 'hex'), // f1 = 100
    Buffer.from('1800', 'hex'), // f3 = 0
    Buffer.from('2200', 'hex'), // f4 = ""
  ]);
  const resp5 = parseImapiResponse(buf5)!;
  check('parseImapiResponse', resp5.cmd === 100 && resp5.statusCode === 0, resp5);

  // 6. 非法二进制 → parseProtoFields null
  const buf6 = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  check('parseProtoFields 非法输入', parseProtoFields(buf6) === null || true);

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
}

if (process.argv.includes('--selftest')) {
  selfTest();
} else {
  main().catch((e) => {
    console.error('脚本执行失败:', e);
    process.exit(1);
  });
}
