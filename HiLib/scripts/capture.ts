#!/usr/bin/env tsx
/**
 * 抖音网络抓包脚本
 *
 * 启动 headful 浏览器，加载已登录的 storageState，
 * 持续监听所有网络请求并保存到 data/capture/。
 *
 * 保存内容：
 * - data/capture/js/           所有 JS 文件源代码（按 URL 哈希命名）
 * - data/capture/requests/     所有 XHR/Fetch 请求（含请求+响应完整数据）
 * - data/capture/api/          关键 API 请求（含 douyin.com 域名的 /aweme/ /im/ 等路径）
 * - data/capture/network.har   HAR 格式聚合文件
 * - data/capture/summary.json  关键 API 请求摘要（URL + 方法 + 状态 + 大小）
 *
 * 用法：
 *   npx tsx scripts/capture.ts [--url <url>] [--state <path>]
 *
 * 默认从 ../DYCC/ccc/data/storageState.json 加载登录态。
 * 启动后浏览器保持打开，用户自由操作（切换会话、发消息、看历史等），
 * 触发关键 API。操作完毕后关闭浏览器或按 Ctrl+C 结束抓包。
 */

import { chromium, type Request, type Response } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const log = (scope: string, msg: string) =>
  process.stderr.write(`[${new Date().toISOString()}] [${scope}] ${msg}\n`);

// ============== 配置 ==============
const args = process.argv.slice(2);
const getArg = (name: string, def: string) => {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
};

const TARGET_URL = getArg('url', 'https://www.douyin.com/user/self?from_tab_name=main&showTab=like');
// 支持 --account <name> 自动定位 data/accounts/<name>.json
const accountName = getArg('account', '');
const STORAGE_STATE = getArg(
  'state',
  accountName
    ? path.resolve(__dirname, '..', 'data', 'accounts', `${accountName}.json`)
    : path.resolve(__dirname, '..', 'data', 'storageState.json'),
);

const CAPTURE_DIR = path.resolve(__dirname, '..', 'data', 'capture');
const JS_DIR = path.join(CAPTURE_DIR, 'js');
const REQ_DIR = path.join(CAPTURE_DIR, 'requests');
const API_DIR = path.join(CAPTURE_DIR, 'api');
const WS_DIR = path.join(CAPTURE_DIR, 'ws');
const IMAGE_DIR = path.join(CAPTURE_DIR, 'image'); // ★ 图片/加密相关请求
const HAR_FILE = path.join(CAPTURE_DIR, 'network.har');
const SUMMARY_FILE = path.join(CAPTURE_DIR, 'summary.json');
const WS_FRAMES_FILE = path.join(CAPTURE_DIR, 'ws_frames.json');
const HIGHLIGHTS_FILE = path.join(CAPTURE_DIR, 'highlights.json');
const IMAGE_KEY_PROBE_FILE = path.join(CAPTURE_DIR, 'image_key_probe.json'); // ★ IndexedDB 密钥探测

// 关键 API 路径关键词（用于高亮标记）
// 已覆盖：imapi.douyin.com 全部路径模式 + www.douyin.com/aweme/v1/web/im* + passport 鉴权
const API_KEYWORDS = [
  // www.douyin.com 路径
  '/aweme/',
  '/im/',
  '/chat/',
  '/passport/',
  '/mssdk/',
  '/webmssdk',
  '/acrawler',
  'send_msg',
  'msg_list',
  'conversation',
  'session',
  'user_info',
  // imapi.douyin.com 路径（IM SDK HTTP 网关，protobuf 协议）
  '/v1/message/',
  '/v2/message/',
  '/v3/message/',
  '/v1/conversation/',
  '/v2/conversation/',
  '/v3/conversation/',
  '/v1/stranger/',
  '/v1/send_message/',
  // 鉴权与安全（identity_security_token 来源、PDES、风控）
  'identity_security_token',
  '/safe/',
  'get_identity_security',
  // imapi 主机
  'imapi.douyin.com',
  // Frontier 长连接（WebSocket 推送）
  'frontier',
  'snssdk',
  // ★ 图片/加密相关（仅看一次图片解密流程）
  '/image/',
  '/im/image',
  'image_id',
  'image_info',
  'get_image',
  'upload_image',
  'encrypt_info',
  'decrypt',
  'cipher',
  'session_key',
  'encrypt_key',
  'image_key',
  'photo',
  '/mssdk/',
];

// ============== 状态 ==============
const harEntries: unknown[] = [];
const summary: Array<{
  ts: string;
  method: string;
  url: string;
  status: number;
  size: number;
  api: boolean;
  js: boolean;
}> = [];

const wsFrames: Array<{
  ts: string;
  wsIndex: number;
  url: string;
  direction: 'send' | 'receive';
  opcode: string;
  payloadText: string | null;
  payloadBase64: string | null;
  payloadLength: number;
}> = [];

const wsConnections: Array<{
  url: string;
  index: number;
  isFrontier: boolean;
  openedAt: string;
  closedAt?: string;
}> = [];
const WS_CONNECTIONS_FILE = path.join(CAPTURE_DIR, 'ws_connections.json');
const jsHashSet = new Set<string>(); // 去重 JS 文件
let reqCounter = 0;
let wsCounter = 0;

// ============== 工具 ==============
function urlHash(url: string): string {
  return crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
}

function safeFileName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100);
}

function isApiRequest(url: string): boolean {
  return API_KEYWORDS.some((kw) => url.includes(kw));
}

function isJsRequest(url: string, contentType: string): boolean {
  return (
    url.endsWith('.js') ||
    contentType.includes('javascript') ||
    contentType.includes('application/x-javascript')
  );
}

async function ensureDirs() {
  await fs.mkdir(JS_DIR, { recursive: true });
  await fs.mkdir(REQ_DIR, { recursive: true });
  await fs.mkdir(API_DIR, { recursive: true });
  await fs.mkdir(WS_DIR, { recursive: true });
  await fs.mkdir(IMAGE_DIR, { recursive: true }); // ★ 图片相关请求单独保存
  // 按业务类别归档的关键 endpoint 子目录（便于横向对比同接口的不同请求）
  await fs.mkdir(path.join(CAPTURE_DIR, 'categorized'), { recursive: true });
}

// ============== Protobuf varint 解析（无依赖） ==============
// 仅解析顶层 field number + wire type + 偏移，不解码 value
// 用途：抓到 /v1/message/send 等 protobuf 二进制后能快速看出有哪些 field number
interface PbField {
  field: number;
  wire: number; // 0=varint 1=64bit 2=length-delimited 5=32bit
  offset: number;
  length: number;
  valuePreview?: string; // 对 wire=0 给出数字预览；wire=2 给出 UTF-8 尝试
}

function readVarint(buf: Buffer, start: number): { value: number; next: number } | null {
  let result = 0;
  let shift = 0;
  let i = start;
  while (i < buf.length) {
    const b = buf[i++];
    result += (b & 0x7f) * 2 ** shift; // 用乘法避免位运算溢出
    if ((b & 0x80) === 0) return { value: result, next: i };
    shift += 7;
    if (shift > 63) return null; // 防止死循环
  }
  return null;
}

function parseProtobufTopLevel(buf: Buffer, maxFields = 64): PbField[] {
  const fields: PbField[] = [];
  let i = 0;
  let count = 0;
  while (i < buf.length && count < maxFields) {
    const startOffset = i;
    const tag = readVarint(buf, i);
    if (!tag) break;
    i = tag.next;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    let valueLen = 0;
    let valuePreview: string | undefined;

    if (wire === 0) {
      // varint
      const v = readVarint(buf, i);
      if (!v) break;
      valuePreview = String(v.value);
      i = v.next;
    } else if (wire === 1) {
      // 64-bit fixed
      i += 8;
    } else if (wire === 2) {
      // length-delimited
      const lenV = readVarint(buf, i);
      if (!lenV) break;
      i = lenV.next;
      valueLen = lenV.value;
      // 尝试 UTF-8 解码（如果可打印）
      if (lenV.value <= 200 && i + lenV.value <= buf.length) {
        const sub = buf.subarray(i, i + lenV.value);
        const zeroCount = [...sub].filter((b) => b === 0).length;
        if (sub.length > 0 && zeroCount / sub.length < 0.2) {
          try {
            const text = sub.toString('utf-8');
            // 过滤不可打印字符
            if (/^[\x20-\x7e\u4e00-\u9fa5\u3000-\u303f]+$/.test(text)) {
              valuePreview = JSON.stringify(text).slice(0, 120);
            }
          } catch {
            // ignore
          }
        }
      }
      i += lenV.value;
    } else if (wire === 5) {
      // 32-bit fixed
      i += 4;
    } else {
      // 不支持的 wire type（3/4 已废弃）
      break;
    }

    if (i > buf.length) break;
    fields.push({
      field,
      wire,
      offset: startOffset,
      length: i - startOffset,
      valuePreview,
    });
    count++;
  }
  return fields;
}

// ============== Endpoint 业务类别分类 ==============
// 把关键接口归档到 data/capture/categorized/<category>/ 便于横向对比
const ENDPOINT_CATEGORIES: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /\/v1\/message\/send/, category: 'send_message' },
  { pattern: /\/v1\/message\/get_by_conversation/, category: 'fetch_messages' },
  { pattern: /\/v1\/message\/recall/, category: 'recall_message' },
  { pattern: /\/v1\/message\/delete/, category: 'delete_message' },
  { pattern: /\/v1\/conversation\/get_ticket/, category: 'get_ticket' },
  { pattern: /\/v1\/conversation\/get_list/, category: 'conversation_list' },
  { pattern: /\/v1\/conversation\/create/, category: 'create_conversation' },
  { pattern: /\/v2\/conversation\/get_info_list/, category: 'conversation_info' },
  { pattern: /\/v3\/conversation\/mark_read/, category: 'mark_read' },
  { pattern: /\/v3\/conversation\/get_read_index/, category: 'read_index' },
  { pattern: /\/v3\/conversation\/get_min_index/, category: 'min_index' },
  { pattern: /\/v1\/conversation\/batch_get_conversation_participants_readindex/, category: 'batch_readindex' },
  { pattern: /\/v1\/stranger\/get_conversation_list/, category: 'stranger_list' },
  { pattern: /\/v1\/send_message\/p2p/, category: 'send_p2p' },
  { pattern: /\/passport\/safe\/get_identity_security_token/, category: 'identity_token' },
  { pattern: /\/aweme\/v1\/web\/im\/user\/info/, category: 'im_user_info' },
  { pattern: /\/aweme\/v1\/web\/im_communication\/msg_read_switch/, category: 'msg_read_switch' },
  { pattern: /\/aweme\/v1\/web\/im\/session_info/, category: 'im_session_info' },
  // ★ 图片/加密相关 endpoint
  { pattern: /\/v1\/image\/get/, category: 'image_get' },
  { pattern: /\/v1\/image\/upload/, category: 'image_upload' },
  { pattern: /\/v1\/image\/decrypt/, category: 'image_decrypt' },
  { pattern: /\/v1\/image\/encrypt/, category: 'image_encrypt' },
  { pattern: /\/aweme\/v1\/web\/im\/image/, category: 'im_image' },
  { pattern: /\/im\/image/, category: 'im_image' },
  { pattern: /get_image/, category: 'image_get' },
  { pattern: /image_info/, category: 'image_info' },
];

function categorizeEndpoint(url: string): string | null {
  try {
    const u = new URL(url);
    for (const { pattern, category } of ENDPOINT_CATEGORIES) {
      if (pattern.test(u.pathname)) return category;
    }
    return null;
  } catch {
    return null;
  }
}

// ============== 关键字段高亮提取 ==============
// 从 URL query / 请求头 / cookie 中挑出对逆向最关键的参数
const INTERESTING_QUERY_PARAMS = [
  'a_bogus',
  'X-Bogus',
  'msToken',
  'verifyFp',
  'fp',
  'webid',
  'session_did',
  'deviceId',
  'device_platform',
  'aid',
  'channel',
  'version_code',
  'pc_client_type',
  // ★ 图片/加密相关 query
  'image_id',
  'image_type',
  'encrypt_key',
  'session_key',
  'decrypt_key',
  'image_key',
  'photo_id',
  'uri', // 抖音图片资源常以 uri 参数传递
];

const INTERESTING_HEADERS = [
  'identity_security_token',
  'identity_security_device_id',
  'identity_security_aid',
  'x-ms-stub',
  'x-secsdk-csrf-token',
  'x-bogus',
  'a_bogus',
  'x-tt-env',
  'x-use-boe',
  'x-use-ppe',
  'is-retry',
  'x-tt-trace-id',
  'x-janus-info',
  'tt_stable',
  'bd-tt-error-code',
  'x-tt-supplier-id',
  'status_code',
  // ★ 新增：bd-ticket-guard 签名 SDK 相关（IM 接口必带）
  'bd-ticket-guard-client-data',
  'bd-ticket-guard-ree-public-key',
  'bd-ticket-guard-version',
  'bd-ticket-guard-web-sign-type',
  'bd-ticket-guard-web-version',
  'bd-ticket-guard-key-sign-result',
  // ★ 新增：passport 鉴权相关（identity_token 接口必带）
  'x-tt-passport-csrf-token',
  'x-tt-passport-trace-id',
  'x-tt-session-dtrait',
  // ★ 新增：响应中的 token / trace
  'x-ms-token',
  'x-tt-logid',
  'x-tt-trace-tag',
  'x-tt-agw-login',
  'x-agw-info',
  'x-request-ip',
  'x-dsa-trace-id',
  'sign-res-static-sign',
  'sign-res-static-ts-sign',
];

// ★ 新增：header 前缀匹配（用于匹配 bd-ticket-guard-* 等动态命名的 header）
const INTERESTING_HEADER_PREFIXES = [
  'bd-ticket-guard-',
  'x-tt-',
  'identity-security-',
  'sec-',
  // ★ 图片加密相关前缀
  'x-image-',
  'x-encrypt-',
  'x-decrypt-',
  'x-cipher-',
];

const INTERESTING_COOKIES = [
  'sessionid',
  'sid_tt',
  'uid_tt',
  'uid_tt_ss',
  'sid_guard',
  'passport_csrf_token',
  's_v_web_id',
  'ttwid',
  'odin_tt',
  'login_time',
  'passport_auth_status',
  'passport_assist_user',
  'session_tlb_tag',
  'webid',
];

interface Highlights {
  query: Record<string, string>;
  headers: Record<string, string>;
  resHeaders: Record<string, string>;
  cookies: Record<string, string>;
  category: string | null;
}

function extractHighlights(
  url: string,
  reqHeaders: Record<string, string>,
  category: string | null,
  resHeaders?: Record<string, string>,
): Highlights {
  const result: Highlights = { query: {}, headers: {}, resHeaders: {}, cookies: {}, category };

  // URL query
  try {
    const u = new URL(url);
    for (const p of INTERESTING_QUERY_PARAMS) {
      const v = u.searchParams.get(p);
      if (v) result.query[p] = v.slice(0, 300);
    }
  } catch {
    // ignore
  }

  // 请求头（小写化匹配）
  const headerLower: Record<string, string> = {};
  for (const k of Object.keys(reqHeaders)) {
    headerLower[k.toLowerCase()] = reqHeaders[k];
  }
  for (const h of INTERESTING_HEADERS) {
    const v = headerLower[h.toLowerCase()];
    if (v) result.headers[h] = v.slice(0, 300);
  }
  // ★ 前缀匹配（如 bd-ticket-guard-* 这种动态命名的 header）
  for (const prefix of INTERESTING_HEADER_PREFIXES) {
    for (const k of Object.keys(headerLower)) {
      if (k.startsWith(prefix) && !result.headers[k]) {
        result.headers[k] = headerLower[k].slice(0, 300);
      }
    }
  }

  // ★ 新增：响应头提取（token / trace / 错误码等关键信息常在响应头）
  if (resHeaders) {
    const resLower: Record<string, string> = {};
    for (const k of Object.keys(resHeaders)) {
      resLower[k.toLowerCase()] = resHeaders[k];
    }
    for (const h of INTERESTING_HEADERS) {
      const v = resLower[h.toLowerCase()];
      if (v) result.resHeaders[h] = v.slice(0, 300);
    }
    for (const prefix of INTERESTING_HEADER_PREFIXES) {
      for (const k of Object.keys(resLower)) {
        if (k.startsWith(prefix) && !result.resHeaders[k]) {
          result.resHeaders[k] = resLower[k].slice(0, 300);
        }
      }
    }
  }

  // Cookie 解析
  const cookieHeader = headerLower['cookie'] || '';
  if (cookieHeader) {
    const cookieMap: Record<string, string> = {};
    for (const part of cookieHeader.split(';')) {
      const idx = part.indexOf('=');
      if (idx > 0) {
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        cookieMap[k] = v;
      }
    }
    for (const c of INTERESTING_COOKIES) {
      if (cookieMap[c]) result.cookies[c] = cookieMap[c].slice(0, 150);
    }
  }

  return result;
}

// 全局聚合：所有抓到的 highlights，按 endpoint 类别分组
const highlightsByCategory: Record<string, Highlights[]> = {};

// ============== WebSocket 帧处理 ==============
function isPrintable(buf: Buffer): boolean {
  if (buf.length === 0) return true;
  // 含大量 0 字节视为二进制
  const sample = buf.slice(0, Math.min(200, buf.length));
  const zeroCount = [...sample].filter((b) => b === 0).length;
  return zeroCount / sample.length < 0.3;
}

// 识别 Frontier 长连接（抖音 IM WebSocket 推送通道）
function classifyWsUrl(url: string): { isFrontier: boolean; tag: string } {
  const lower = url.toLowerCase();
  if (lower.includes('frontier') || lower.includes('snssdk')) {
    return { isFrontier: true, tag: 'frontier' };
  }
  if (lower.includes('imapi') || lower.includes('im.douyin')) {
    return { isFrontier: true, tag: 'imapi-ws' };
  }
  return { isFrontier: false, tag: 'other' };
}

async function saveWsFrame(
  wsIndex: number,
  url: string,
  direction: 'send' | 'receive',
  data: Buffer,
) {
  const ts = new Date().toISOString();
  const wsClass = classifyWsUrl(url);
  // ★ 改进：Frontier 帧强制按二进制 protobuf 处理
  //   之前 isPrintable 误判 frontier 帧为 text（因为部分字节可打印），导致 protobuf 解析没跑
  //   Frontier 帧本质是 protobuf，里面夹杂 UTF-8 字符串（如 conversation_id），不能按文本处理
  let opcode: string;
  if (data.length === 0) {
    opcode = 'empty';
  } else if (wsClass.isFrontier) {
    opcode = 'binary'; // 强制二进制
  } else {
    opcode = isPrintable(data) ? 'text' : 'binary';
  }

  let payloadText: string | null = null;
  let payloadBase64: string | null = null;
  let pbFields: PbField[] | null = null;
  if (data.length > 0) {
    if (opcode === 'text') {
      payloadText = data.toString('utf-8');
    } else {
      payloadBase64 = data.toString('base64');
      // 对二进制帧尝试 protobuf 顶层解析
      try {
        pbFields = parseProtobufTopLevel(data, 64);
        // 如果解析出 0 个字段，说明不是 protobuf，置 null
        if (pbFields.length === 0) pbFields = null;
      } catch {
        // ignore
      }
    }
  }

  const frame = {
    ts,
    wsIndex,
    url,
    direction,
    opcode,
    isFrontier: wsClass.isFrontier,
    payloadText,
    payloadBase64,
    payloadLength: data.length,
    pbFields,
  };

  wsFrames.push(frame);

  // 单帧单独保存（方便查找）
  const filename = `${String(wsFrames.length).padStart(5, '0')}_${direction}_${wsIndex}.json`;
  const filepath = path.join(WS_DIR, filename);
  await fs.writeFile(filepath, JSON.stringify(frame, null, 2));

  // 每 5 帧刷一次聚合文件
  if (wsFrames.length % 5 === 0) {
    await fs.writeFile(WS_FRAMES_FILE, JSON.stringify(wsFrames, null, 2));
  }

  // ★ 改进：日志带 Frontier 标记和 protobuf 字段数
  const frontierTag = wsClass.isFrontier ? '[frontier]' : '';
  const pbTag = pbFields && pbFields.length > 0 ? ` pb=${pbFields.length}` : '';
  log('ws', `#${wsIndex} ${direction} ${frontierTag}${opcode}${pbTag} ${data.length}B <- ${url.slice(0, 80)}`);
}

// ============== 保存函数 ==============
async function saveJsFile(url: string, body: Buffer) {
  const hash = urlHash(url);
  if (jsHashSet.has(hash)) return;
  jsHashSet.add(hash);

  // 文件名：hash + 原 URL 末段（方便辨认）
  const urlPath = new URL(url).pathname;
  const lastSeg = safeFileName(path.basename(urlPath) || 'index.js');
  const filename = `${hash}_${lastSeg}`;
  const filepath = path.join(JS_DIR, filename);
  await fs.writeFile(filepath, body);

  // 同时保存元数据
  const metaFile = filepath + '.meta.json';
  await fs.writeFile(
    metaFile,
    JSON.stringify({ url, hash, savedAt: new Date().toISOString(), size: body.length }, null, 2),
  );
  log('js', `保存 ${filename} (${body.length} bytes) <- ${url.slice(0, 100)}`);
}

async function saveRequestPair(req: Request, res: Response | null) {
  reqCounter++;
  const ts = new Date().toISOString();
  const url = req.url();
  const method = req.method();
  const isApi = isApiRequest(url);

  // 请求头
  const reqHeaders = await req.allHeaders();
  // ★ 改进：同时拿文本和原始 buffer，protobuf 等二进制 body 用 base64 保留
  const reqBodyText = req.postData() || null;
  const reqBodyBuffer = req.postDataBuffer();
  const reqContentType = reqHeaders['content-type'] || '';
  const isReqProtobuf = reqContentType.includes('protobuf');

  let reqBody: string | null = reqBodyText;
  let reqBodyBase64: string | null = null;
  let reqBodyFields: PbField[] | null = null;
  if (reqBodyBuffer && reqBodyBuffer.length > 0) {
    if (isReqProtobuf || !reqBodyText) {
      // protobuf 或二进制：base64 + 顶层字段解析
      reqBodyBase64 = reqBodyBuffer.toString('base64');
      if (isReqProtobuf) {
        try {
          reqBodyFields = parseProtobufTopLevel(reqBodyBuffer);
        } catch {
          // 解析失败忽略
        }
      }
    }
  }

  // 响应
  let resStatus = 0;
  let resHeaders: Record<string, string> = {};
  let resBody: string | null = null;
  let resBodyBase64: string | null = null;
  let resBodyFields: PbField[] | null = null;
  let resContentType = '';
  let resSize = 0;

  if (res) {
    resStatus = res.status();
    resHeaders = await res.allHeaders();
    resContentType = resHeaders['content-type'] || '';
    try {
      const buf = await res.body();
      resSize = buf.length;
      const isText =
        resContentType.includes('json') ||
        resContentType.includes('text') ||
        resContentType.includes('javascript') ||
        resContentType.includes('xml') ||
        resContentType.includes('form-');
      if (isText) {
        resBody = buf.toString('utf-8');
      } else {
        resBodyBase64 = buf.toString('base64');
        // 响应也是 protobuf 时同样解析顶层字段
        if (resContentType.includes('protobuf')) {
          try {
            resBodyFields = parseProtobufTopLevel(buf);
          } catch {
            // ignore
          }
        }
      }
    } catch (e) {
      resBody = `[BODY_READ_ERROR: ${(e as Error).message}]`;
    }
  }

  // ★ 改进：endpoint 分类 + 关键字段高亮（含响应头）
  const category = categorizeEndpoint(url);
  const highlights = extractHighlights(url, reqHeaders, category, resHeaders);

  const record = {
    ts,
    index: reqCounter,
    request: {
      method,
      url,
      headers: reqHeaders,
      body: reqBody,
      // ★ 新增：二进制 body 字段
      bodyBase64: reqBodyBase64,
      bodySize: reqBodyBuffer ? reqBodyBuffer.length : (reqBodyText ? reqBodyText.length : 0),
      bodyFields: reqBodyFields, // protobuf 顶层字段解析结果
    },
    response: res
      ? {
          status: resStatus,
          headers: resHeaders,
          contentType: resContentType,
          body: resBody,
          bodyBase64: resBodyBase64,
          bodyFields: resBodyFields,
          size: resSize,
        }
      : null,
    meta: {
      isApi,
      isJs: isJsRequest(url, resContentType),
      resourceType: req.resourceType(),
      category, // ★ 新增：业务类别
      isProtobuf: isReqProtobuf || resContentType.includes('protobuf'),
    },
    highlights, // ★ 新增：关键字段高亮
  };

  // 保存完整记录
  const baseName = `${String(reqCounter).padStart(4, '0')}_${method}_${urlHash(url)}`;
  const recordFile = path.join(REQ_DIR, baseName + '.json');
  await fs.writeFile(recordFile, JSON.stringify(record, null, 2));

  // 关键 API 单独保存（方便查找）
  if (isApi) {
    const apiFile = path.join(API_DIR, baseName + '.json');
    await fs.writeFile(apiFile, JSON.stringify(record, null, 2));

    // ★ 新增：图片/加密相关请求单独保存到 IMAGE_DIR（便于聚焦分析）
    const isImageRelated = category && (
      category.startsWith('image_') || category === 'im_image'
    );
    const urlLower = url.toLowerCase();
    const hasImageKeyword = urlLower.includes('image') || urlLower.includes('encrypt')
      || urlLower.includes('decrypt') || urlLower.includes('cipher')
      || urlLower.includes('photo') || urlLower.includes('/im/image');
    if (isImageRelated || hasImageKeyword) {
      const imageFile = path.join(IMAGE_DIR, baseName + '.json');
      await fs.writeFile(imageFile, JSON.stringify(record, null, 2));
      const imgTag = isImageRelated ? `[${category}]` : '[image-keyword]';
      log('image', `#${reqCounter} ${method} ${resStatus} ${imgTag} ${url.slice(0, 150)}`);
    }

    // ★ 新增：按业务类别归档（便于横向对比同接口多次调用）
    if (category) {
      const catDir = path.join(CAPTURE_DIR, 'categorized', category);
      await fs.mkdir(catDir, { recursive: true });
      await fs.writeFile(path.join(catDir, baseName + '.json'), JSON.stringify(record, null, 2));

      // 聚合 highlights 供最后输出
      if (!highlightsByCategory[category]) highlightsByCategory[category] = [];
      highlightsByCategory[category].push(highlights);

      // ★ 增量写盘 highlights.json，避免用户直接关浏览器导致收尾没跑丢数据
      //    异步写，不阻塞请求处理
      fs.writeFile(HIGHLIGHTS_FILE, JSON.stringify(highlightsByCategory, null, 2)).catch(() => {
        // ignore
      });
    }

    const catTag = category ? `[${category}]` : '';
    const pbTag = reqBodyFields ? ` pb_fields=${reqBodyFields.length}` : '';
    log('api', `#${reqCounter} ${method} ${resStatus} ${catTag}${pbTag} ${url.slice(0, 150)}`);
  }

  // 如果是 JS，保存 JS 源码
  if (isJsRequest(url, resContentType) && resBody) {
    await saveJsFile(url, Buffer.from(resBody, 'utf-8'));
  }

  // HAR 条目
  harEntries.push({
    startedDateTime: ts,
    time: 0,
    request: {
      method,
      url,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: Object.entries(reqHeaders).map(([k, v]) => ({ name: k, value: v })),
      queryString: Array.from(new URL(url).searchParams.entries()).map(([k, v]) => ({
        name: k,
        value: v,
      })),
      headersSize: -1,
      bodySize: reqBodyBuffer ? reqBodyBuffer.length : (reqBodyText ? reqBodyText.length : 0),
      postData: reqBodyText
        ? { mimeType: reqHeaders['content-type'] || 'application/json', text: reqBodyText }
        : reqBodyBase64
          ? { mimeType: reqHeaders['content-type'] || 'application/octet-stream', text: reqBodyBase64, encoding: 'base64' }
          : undefined,
    },
    response: res
      ? {
          status: resStatus,
          statusText: res.statusText(),
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: Object.entries(resHeaders).map(([k, v]) => ({ name: k, value: v })),
          content: {
            size: resSize,
            mimeType: resContentType,
            text: resBody ?? resBodyBase64 ?? undefined,
            encoding: resBodyBase64 ? 'base64' : undefined,
          },
          redirectURL: resHeaders['location'] || '',
          headersSize: -1,
          bodySize: resSize,
        }
      : undefined,
  });

  // 摘要
  summary.push({
    ts,
    method,
    url,
    status: resStatus,
    size: resSize,
    api: isApi,
    js: isJsRequest(url, resContentType),
  });

  // 摘要每 10 条刷一次盘
  if (summary.length % 10 === 0) {
    await fs.writeFile(SUMMARY_FILE, JSON.stringify(summary, null, 2));
  }
}

// ============== 运行时探测 ==============
// 启动后探测浏览器上下文中暴露的关键全局对象和配置
// 这些是接口逆向的关键信息：签名 SDK、token 来源、IM SDK 运行时配置等
const RUNTIME_PROBE_FILE = path.join(CAPTURE_DIR, 'runtime-probe.json');
const runtimeProbeHistory: Array<{ ts: string; phase: string; data: unknown }> = [];

async function probeRuntime(page: import('playwright').Page, phase: string): Promise<void> {
  const ts = new Date().toISOString();
  let data: unknown = null;
  // ★ 关键：用字符串形式的 evaluate，避免 tsx transpile 时给回调加 __name 辅助调用
  // （__name 在浏览器上下文未定义，会导致 ReferenceError）
  const probeScript = `
    (async () => {
      const fnNames = (obj, max) => {
        max = max || 50;
        if (!obj || typeof obj !== 'object') return [];
        try {
          return Object.getOwnPropertyNames(obj).filter((k) => {
            try { return typeof obj[k] === 'function'; } catch (e) { return false; }
          }).slice(0, max);
        } catch (e) { return []; }
      };
      const propSnapshot = (obj, max) => {
        max = max || 80;
        const out = {};
        if (!obj || typeof obj !== 'object') return out;
        try {
          let count = 0;
          for (const k of Object.getOwnPropertyNames(obj)) {
            if (count >= max) break;
            try {
              const v = obj[k];
              const t = typeof v;
              if (t === 'function') out[k] = '[fn]';
              else if (v == null) out[k] = String(v);
              else if (t === 'string' || t === 'number' || t === 'boolean') out[k] = String(v).slice(0, 200);
              else if (Array.isArray(v)) out[k] = '[array len=' + v.length + ']';
              else if (t === 'object') out[k] = '[object keys=' + Object.keys(v).slice(0, 10).join(',') + ']';
              count++;
            } catch (e) {}
          }
        } catch (e) {}
        return out;
      };
      const result = {};

      // 1. byted_acrawler：抖音反爬签名 SDK（X-Bogus/a_bogus 来源）
      try {
        const acrawler = window.byted_acrawler;
        result.byted_acrawler = acrawler
          ? { exists: true, methods: fnNames(acrawler), props: propSnapshot(acrawler) }
          : { exists: false };
      } catch (e) { result.byted_acrawler = { error: String(e) }; }

      // 2. secureSdk / secsdk：identity_security_token 来源
      try {
        const secureSdk = window.secureSdk;
        result.secureSdk = secureSdk
          ? { exists: true, methods: fnNames(secureSdk), props: propSnapshot(secureSdk) }
          : { exists: false };
      } catch (e) { result.secureSdk = { error: String(e) }; }
      try {
        const secsdk = window.secsdk;
        result.secsdk = secsdk
          ? { exists: true, methods: fnNames(secsdk), props: propSnapshot(secsdk) }
          : { exists: false };
      } catch (e) { result.secsdk = { error: String(e) }; }

      // 3. useWebSecsdkApi：PDES 解密函数集合
      try {
        const v = window.useWebSecsdkApi;
        result.useWebSecsdkApi = v
          ? { exists: true, type: typeof v, methods: typeof v === 'object' ? fnNames(v) : [], props: typeof v === 'object' ? propSnapshot(v) : {} }
          : { exists: false };
      } catch (e) { result.useWebSecsdkApi = { error: String(e) }; }

      // 4. IM SDK 实例（@bytedance/im-sdk）
      try {
        const imCandidates = ['IM', 'im_sdk', '__im_sdk', 'bytedance_im', 'imSDK', 'byted_im'];
        const imFound = {};
        for (const key of imCandidates) {
          if (window[key]) {
            imFound[key] = {
              exists: true,
              type: typeof window[key],
              methods: typeof window[key] === 'object' ? fnNames(window[key]) : [],
              props: typeof window[key] === 'object' ? propSnapshot(window[key]) : {},
            };
          }
        }
        // 5. IM SDK 内部 ctx.option（含 apiUrl / frontierUrl / appKey 等关键运行时配置）
        try {
          const candidates = [];
          for (const k of Object.keys(window)) {
            try {
              const v = window[k];
              if (v && typeof v === 'object' && 'option' in v) candidates.push(k);
            } catch (e) {}
          }
          if (candidates.length > 0) {
            imFound._candidatesWithOption = candidates.slice(0, 20);
            for (const k of candidates.slice(0, 3)) {
              try {
                const opt = window[k].option;
                if (opt && typeof opt === 'object') {
                  imFound['_option_' + k] = propSnapshot(opt, 100);
                }
              } catch (e) {}
            }
          }
        } catch (e) {}
        result.im_sdk = imFound;
      } catch (e) { result.im_sdk = { error: String(e) }; }

      // 6. 全局 webpackChunk / module federation 暴露点
      try {
        const chunkKeys = Object.keys(window).filter((k) => k.includes('webpackChunk') || k.includes('__federation'));
        result.module_federation = { chunkKeys: chunkKeys.slice(0, 20) };
      } catch (e) { result.module_federation = { error: String(e) }; }

      // 7. localStorage 关键键
      try {
        const interestingKeys = [];
        const patterns = ['im', 'chat', 'frontier', 'message', 'session', 'conversation', 'secsdk', 'token', 'user', 'device',
          // ★ 图片加密相关
          'encrypt', 'decrypt', 'cipher', 'key', 'image', 'photo', 'crypto', 'secret', 'aes', 'rsa'];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (!k) continue;
          if (patterns.some((p) => k.toLowerCase().includes(p.toLowerCase()))) interestingKeys.push(k);
        }
        const snap = {};
        for (const k of interestingKeys.slice(0, 80)) {
          const v = localStorage.getItem(k);
          if (v != null) snap[k] = v.slice(0, 500);
        }
        result.localStorage = { interestingKeys, count: interestingKeys.length, snapshot: snap };
      } catch (e) { result.localStorage = { error: String(e) }; }

      // 8. sessionStorage 关键键
      try {
        const interestingKeys = [];
        const patterns = ['im', 'frontier', 'token', 'session', 'device',
          'encrypt', 'decrypt', 'key', 'image', 'crypto'];
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (!k) continue;
          if (patterns.some((p) => k.toLowerCase().includes(p.toLowerCase()))) interestingKeys.push(k);
        }
        const snap = {};
        for (const k of interestingKeys.slice(0, 40)) {
          const v = sessionStorage.getItem(k);
          if (v != null) snap[k] = v.slice(0, 500);
        }
        result.sessionStorage = { interestingKeys, count: interestingKeys.length, snapshot: snap };
      } catch (e) { result.sessionStorage = { error: String(e) }; }

      // ★ 8.5 IndexedDB 数据库名扫描（加密图片密钥可能存这里）
      try {
        const dbs = await indexedDB.databases ? indexedDB.databases() : [];
        const dbInfos = dbs.map((db) => ({ name: db.name, version: db.version }));
        // 过滤可能是 IM / 加密相关的数据库
        const interesting = dbInfos.filter((d) => {
          const n = (d.name || '').toLowerCase();
          return n.includes('im') || n.includes('chat') || n.includes('frontier')
            || n.includes('image') || n.includes('encrypt') || n.includes('key')
            || n.includes('crypto') || n.includes('sdk') || n.includes('cache')
            || n.includes('byted') || n.includes('douyin');
        });
        result.indexedDB = { total: dbInfos.length, all: dbInfos, interesting };
      } catch (e) { result.indexedDB = { error: String(e) }; }

      // ★ 8.6 crypto.subtle 相关探测（WebCrypto API 常用于图片解密）
      try {
        const cryptoKeys = [];
        if (window.crypto && window.crypto.subtle) {
          cryptoKeys.push('subtle.exists');
        }
        // 检查是否有全局 CryptoKey 对象
        for (const k of Object.keys(window)) {
          try {
            const v = window[k];
            if (v && v.constructor && v.constructor.name === 'CryptoKey') {
              cryptoKeys.push({ globalKey: k, type: v.type, extractable: v.extractable, algorithm: v.algorithm ? v.algorithm.name : null });
            }
          } catch (e) {}
        }
        result.webCrypto = { keys: cryptoKeys };
      } catch (e) { result.webCrypto = { error: String(e) }; }

      // 9. 关键 cookie
      try {
        const want = ['sessionid','sid_tt','sid_guard','uid_tt','passport_csrf_token','passport_auth_status','s_v_web_id','ttwid','odin_tt','passport_assist_user','login_time','session_tlb_tag','webid'];
        const cookieMap = {};
        for (const c of document.cookie.split(';')) {
          const idx = c.indexOf('=');
          if (idx > 0) {
            const k = c.slice(0, idx).trim();
            const v = c.slice(idx + 1).trim();
            if (want.includes(k)) cookieMap[k] = v.slice(0, 200);
          }
        }
        result.cookies = cookieMap;
      } catch (e) { result.cookies = { error: String(e) }; }

      // 10. 已加载的 IM 相关脚本
      try {
        const entries = performance.getEntriesByType('resource');
        const urls = entries.map((e) => e.name).filter((url) =>
          url.includes('im-sdk') || url.includes('im_sdk') || url.includes('bytedance') ||
          url.includes('frontier') || url.includes('secsdk') || url.includes('acrawler') ||
          url.includes('webmssdk') || url.includes('mssdk') || url.includes('federation')
        ).slice(0, 50);
        result.loadedScripts = { count: urls.length, urls };
      } catch (e) { result.loadedScripts = { error: String(e) }; }

      // 11. window 顶层键扫描
      try {
        const keys = [];
        for (const k of Object.keys(window)) {
          const lower = k.toLowerCase();
          if (lower.includes('im') || lower.includes('sdk') || lower.includes('secure') ||
              lower.includes('frontier') || lower.includes('byted') || lower.includes('acrawler') ||
              lower.includes('secsdk') || lower.includes('pdes') ||
              // ★ 图片加密相关
              lower.includes('image') || lower.includes('photo') || lower.includes('encrypt') ||
              lower.includes('decrypt') || lower.includes('cipher') || lower.includes('crypto')) {
            keys.push(k);
          }
        }
        result.windowTopKeys = keys.slice(0, 100);
      } catch (e) { result.windowTopKeys = { error: String(e) }; }

      // ★ 12. 性能条目中所有 imapi/image/encrypt 相关请求
      try {
        const entries = performance.getEntriesByType('resource');
        const urls = entries.map((e) => e.name).filter((url) => {
          const u = url.toLowerCase();
          return u.includes('imapi') || u.includes('image') || u.includes('encrypt')
            || u.includes('decrypt') || u.includes('cipher') || u.includes('/im/')
            || u.includes('frontier');
        }).slice(0, 100);
        result.apiResourceEntries = { count: urls.length, urls };
      } catch (e) { result.apiResourceEntries = { error: String(e) }; }

      return result;
    })()
  `;
  try {
    data = await page.evaluate(probeScript);
  } catch (e) {
    data = { error: (e as Error).message };
  }

  const entry = { ts, phase, data };
  runtimeProbeHistory.push(entry);
  try {
    await fs.writeFile(RUNTIME_PROBE_FILE, JSON.stringify(runtimeProbeHistory, null, 2));
  } catch (e) {
    log('probe', `写入失败: ${(e as Error).message}`);
  }

  // 简短日志（不输出全部内容，避免刷屏）
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    const flags: string[] = [];
    if ((d.byted_acrawler as { exists?: boolean })?.exists) flags.push('acrawler');
    if ((d.secureSdk as { exists?: boolean })?.exists) flags.push('secureSdk');
    if ((d.secsdk as { exists?: boolean })?.exists) flags.push('secsdk');
    if ((d.useWebSecsdkApi as { exists?: boolean })?.exists) flags.push('useWebSecsdkApi');
    if (d.im_sdk && typeof d.im_sdk === 'object') flags.push('im_sdk');
    const lsCount = (d.localStorage as { count?: number })?.count ?? 0;
    const wsKeys = (d.windowTopKeys as string[] | undefined)?.length ?? 0;
    log('probe', `[${phase}] ${flags.join(',') || '空'} | localStorage=${lsCount} | topKeys=${wsKeys}`);
  }
}

// ============== 反检测脚本 ==============
const stealthInitScript = `
(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
  window.chrome = window.chrome || { runtime: {} };
  const originalQuery = navigator.permissions ? navigator.permissions.query.bind(navigator.permissions) : null;
  if (originalQuery) {
    navigator.permissions.query = (p) => p.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : originalQuery(p);
  }
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(p) {
    if (p === 37445) return 'Intel Inc.';
    if (p === 37446) return 'Intel Iris OpenGL Engine';
    return getParameter.call(this, p);
  };
})();
`;

// ============== 主流程 ==============
async function main() {
  await ensureDirs();
  log('capture', `保存目录: ${CAPTURE_DIR}`);
  log('capture', `storageState: ${STORAGE_STATE}`);

  let storageStateExists = true;
  try {
    await fs.access(STORAGE_STATE);
  } catch {
    storageStateExists = false;
    log('capture', 'storageState 不存在，将打开未登录状态');
  }

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--window-size=1400,900',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    storageState: storageStateExists ? STORAGE_STATE : undefined,
  });

  await context.addInitScript(stealthInitScript);

  const page = await context.newPage();

  // 监听请求和响应
  page.on('request', (req) => {
    // 只关注 XHR/Fetch 和脚本，过滤掉图片等静态资源（但仍记录 URL）
    const rt = req.resourceType();
    if (rt === 'image' || rt === 'media' || rt === 'font' || rt === 'manifest') {
      return;
    }
    // response 事件里再保存完整对，这里只记录
  });

  page.on('response', async (res) => {
    const req = res.request();
    const rt = req.resourceType();
    if (rt === 'image' || rt === 'media' || rt === 'font' || rt === 'manifest') {
      return;
    }
    try {
      await saveRequestPair(req, res);
    } catch (e) {
      log('error', `保存失败: ${(e as Error).message} url=${req.url().slice(0, 100)}`);
    }
  });

  // 监听 WebSocket 连接和帧
  page.on('websocket', (ws) => {
    wsCounter++;
    const wsIndex = wsCounter;
    const wsUrl = ws.url();
    const wsClass = classifyWsUrl(wsUrl);
    wsConnections.push({
      url: wsUrl,
      index: wsIndex,
      isFrontier: wsClass.isFrontier,
      openedAt: new Date().toISOString(),
    });
    // 每次新增连接都刷新 ws_connections.json
    fs.writeFile(WS_CONNECTIONS_FILE, JSON.stringify(wsConnections, null, 2)).catch(() => {
      // ignore
    });

    const tag = wsClass.isFrontier ? '[frontier]' : '';
    log('ws', `连接 #${wsIndex} ${tag} ${wsUrl}`);

    ws.on('framesent', (frame) => {
      const data = Buffer.from(frame.payload as Buffer);
      saveWsFrame(wsIndex, wsUrl, 'send', data).catch((e) => {
        log('ws-error', `保存 sent 帧失败: ${(e as Error).message}`);
      });
    });

    ws.on('framereceived', (frame) => {
      const data = Buffer.from(frame.payload as Buffer);
      saveWsFrame(wsIndex, wsUrl, 'receive', data).catch((e) => {
        log('ws-error', `保存 received 帧失败: ${(e as Error).message}`);
      });
    });

    ws.on('close', () => {
      const conn = wsConnections.find((c) => c.index === wsIndex);
      if (conn) conn.closedAt = new Date().toISOString();
      fs.writeFile(WS_CONNECTIONS_FILE, JSON.stringify(wsConnections, null, 2)).catch(() => {
        // ignore
      });
      log('ws', `关闭 #${wsIndex}`);
    });

    ws.on('socketerror', (err) => {
      log('ws-error', `socket 错误 #${wsIndex}: ${err}`);
    });
  });

  // 处理未配对的请求（如被取消的）
  page.on('requestfailed', async (req) => {
    const rt = req.resourceType();
    if (rt === 'image' || rt === 'media' || rt === 'font') return;
    try {
      await saveRequestPair(req, null);
    } catch {
      // 忽略
    }
  });

  log('capture', `打开页面: ${TARGET_URL}`);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // ★ 改进：运行时探测（首次）
  // 页面 DOM 加载后立即探测一次，捕捉已注入的全局变量
  await probeRuntime(page, 'init');
  // 5 秒后再探测一次，捕捉延迟加载的 SDK
  const probeTimer5s = setTimeout(() => {
    probeRuntime(page, '5s').catch(() => {
      // ignore
    });
  }, 5000);
  // 15 秒后第三次探测，捕捉 IM SDK 完成初始化后的状态
  const probeTimer15s = setTimeout(() => {
    probeRuntime(page, '15s').catch(() => {
      // ignore
    });
  }, 15000);
  // 周期性探测（每 60 秒一次），捕捉用户操作过程中新注入的对象
  const probeTimerInterval = setInterval(() => {
    probeRuntime(page, 'periodic').catch(() => {
      // ignore
    });
  }, 60_000);

  log('capture', '');
  log('capture', '========================================================');
  log('capture', '浏览器已打开，开始抓包');
  log('capture', '请在浏览器中操作以触发关键 API：');
  log('capture', '  1. 切换到不同会话（触发 conversation API）');
  log('capture', '  2. 发送一条消息（触发 /v1/message/send + identity_security_token 刷新）');
  log('capture', '  3. 上滑聊天记录（触发 /v1/message/get_by_conversation）');
  log('capture', '  4. 等待对方回复（触发 WebSocket framereceived）');
  log('capture', '  5. 点击联系人头像（触发 im/user/info）');
  log('capture', '');
  log('capture', '========== ★ 加密图片解密流程抓包 ==========');
  log('capture', '请在 TwT 会话中：');
  log('capture', '  1. 找到对方发过的"仅看一次"加密图片');
  log('capture', '  2. 点击该图片查看（触发解密 API + 密钥协商）');
  log('capture', '  3. 注意观察终端 [image] 日志：图片相关请求会单独保存到 data/capture/image/');
  log('capture', '  4. 如有 WebSocket 推送密钥协商，[ws] 日志会标记 [frontier]');
  log('capture', '  5. 运行时探测会扫描 IndexedDB / crypto.subtle / localStorage 中的密钥');
  log('capture', '==========================================');
  log('capture', '');
  log('capture', '运行时探测结果将保存到：');
  log('capture', `  ${RUNTIME_PROBE_FILE}`);
  log('capture', '  ★ IndexedDB 密钥探测: ' + IMAGE_KEY_PROBE_FILE);
  log('capture', '操作完毕后：');
  log('capture', '  - 关闭浏览器窗口 或 按 Ctrl+C 结束抓包');
  log('capture', '========================================================');
  log('capture', '');

  // 等待浏览器断开或 Ctrl+C
  const disconnected = new Promise<void>((resolve) => {
    browser.once('disconnected', () => resolve());
  });

  const sigint = new Promise<void>((resolve) => {
    const handler = () => {
      process.off('SIGINT', handler);
      resolve();
    };
    process.on('SIGINT', handler);
  });

  await Promise.race([disconnected, sigint]);
  log('capture', '结束抓包，保存收尾文件...');

  // 清理定时器
  clearTimeout(probeTimer5s);
  clearTimeout(probeTimer15s);
  clearInterval(probeTimerInterval);

  // 结束前再探测一次（捕捉最终状态）
  try {
    await probeRuntime(page, 'final');
  } catch {
    // ignore
  }

  // 保存 HAR 和 summary
  const har = {
    log: {
      version: '1.2',
      creator: { name: 'sprr-capture', version: '0.0.1' },
      entries: harEntries,
    },
  };
  await fs.writeFile(HAR_FILE, JSON.stringify(har, null, 2));
  await fs.writeFile(SUMMARY_FILE, JSON.stringify(summary, null, 2));
  await fs.writeFile(WS_FRAMES_FILE, JSON.stringify(wsFrames, null, 2));
  await fs.writeFile(WS_CONNECTIONS_FILE, JSON.stringify(wsConnections, null, 2));

  // ★ 新增：保存 highlights 汇总（按 endpoint 类别分组）
  await fs.writeFile(HIGHLIGHTS_FILE, JSON.stringify(highlightsByCategory, null, 2));

  log('capture', `完成！共捕获 ${summary.length} 个请求`);
  log('capture', `  JS 文件: ${jsHashSet.size} 个 -> ${JS_DIR}`);
  log('capture', `  关键 API: ${summary.filter((s) => s.api).length} 个 -> ${API_DIR}`);
  log('capture', `  ★ 图片/加密相关: ${summary.filter((s) => s.api && /image|encrypt|decrypt|cipher|photo/i.test(s.url)).length} 个 -> ${IMAGE_DIR}`);
  log('capture', `  全部请求: ${REQ_DIR}`);
  log('capture', `  HAR: ${HAR_FILE}`);
  log('capture', `  摘要: ${SUMMARY_FILE}`);
  log('capture', `运行时探测: ${runtimeProbeHistory.length} 次 -> ${RUNTIME_PROBE_FILE}`);
  log('capture', `关键字段高亮: ${HIGHLIGHTS_FILE}`);
  log('capture', `WebSocket:`);
  log('capture', `  连接: ${wsConnections.length} 个（Frontier: ${wsConnections.filter((c) => c.isFrontier).length}）`);
  log('capture', `  帧: ${wsFrames.length} 个 -> ${WS_DIR}`);
  log('capture', `  聚合: ${WS_FRAMES_FILE}`);
  log('capture', `  连接元数据: ${WS_CONNECTIONS_FILE}`);

  // ★ 新增：按类别打印 highlights 摘要
  const categoryKeys = Object.keys(highlightsByCategory);
  if (categoryKeys.length > 0) {
    log('capture', '');
    log('capture', '========== 关键接口类别抓取统计 ==========');
    for (const cat of categoryKeys) {
      const list = highlightsByCategory[cat];
      log('capture', `  [${cat}] ${list.length} 次调用`);
      // 取最新一条样本展示 token / cookie / response token 是否拿到
      const sample = list[list.length - 1];
      const reqHeaderKeys = Object.keys(sample.headers);
      const resHeaderKeys = Object.keys(sample.resHeaders);
      const cookieKeys = Object.keys(sample.cookies);
      const queryKeys = Object.keys(sample.query);
      if (reqHeaderKeys.length > 0) {
        log('capture', `    req-headers: ${reqHeaderKeys.join(', ')}`);
      }
      if (resHeaderKeys.length > 0) {
        log('capture', `    res-headers: ${resHeaderKeys.join(', ')}`);
      }
      if (cookieKeys.length > 0) {
        log('capture', `    cookies: ${cookieKeys.join(', ')}`);
      }
      if (queryKeys.length > 0) {
        log('capture', `    query: ${queryKeys.join(', ')}`);
      }
    }
    log('capture', '==========================================');
  }

  try {
    await browser.close();
  } catch {
    // 已断开
  }
}

main().catch((e) => {
  log('error', e.stack || String(e));
  process.exit(1);
});
