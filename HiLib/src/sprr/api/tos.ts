/**
 * 抖音 TOS 图片上传（vod.bytedanceapi.com + tos-d-x-hl.douyin.com）
 *
 * 完整流程（基于抓包 0318/0327/0331/0333/0335 逆向）：
 *   1. getUploadConfig  - GET /aweme/v1/web/im/upload/config/v2 → STS 凭证
 *   2. applyUploadInner - GET vod.bytedanceapi.com?Action=ApplyUploadInner → StoreUri + JWT
 *   3. uploadToTos      - POST tos-d-x-hl.douyin.com/upload/v1/{StoreUri} → 上传图片字节
 *   4. commitUploadInner- POST vod.bytedanceapi.com?Action=CommitUploadInner → 加密信息(oid/skey/md5)
 *
 * AWS4-HMAC-SHA256 签名用于 ApplyUploadInner 和 CommitUploadInner。
 */

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createLogger } from '../utils/logger.js';
import { DEFAULT_UA, type RequestEnv } from './imapi.js';

const log = createLogger('tos');

/** TOS 上传配置中的 STS 凭证 */
export interface UploadStsConfig {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  spaceName: string;
  expireAt: number;
}

/** ApplyUploadInner 返回的上传地址 */
export interface ApplyUploadResult {
  storeUri: string;
  auth: string;
  uploadId: string;
  uploadHost: string;
  sessionKey: string;
  storageHeader?: Record<string, string>;
}

/** CommitUploadInner 返回的加密信息 */
export interface CommitUploadResult {
  /** 原始上传 Uri（StoreUri） */
  uri: string;
  /** 加密后的 Uri（即消息 content.resource_url.oid） */
  encryptionUri: string;
  /** AES-256-GCM 密钥（即消息 content.resource_url.skey） */
  secretKey: string;
  /** 算法（固定 aes-256-gcm） */
  algorithm: string;
  /** 原图 MD5（即消息 content.resource_url.md5） */
  sourceMd5: string;
  /** 图片宽度 */
  imgWidth: number;
  /** 图片高度 */
  imgHeight: number;
  /** 图片大小（字节） */
  imgSize: number;
  /** 图片格式（如 jpeg） */
  imgFormat: string;
}

const VOD_API_BASE = 'https://vod.bytedanceapi.com';
const REGION = 'cn-north-1';
const SERVICE = 'vod';

/**
 * 获取上传配置（STS 凭证）
 *
 * GET /aweme/v1/web/im/upload/config/v2
 * 仅需 Cookie（实测与 user/info/ 等接口一致，无需 a_bogus/msToken 签名）。
 */
export async function getUploadConfig(env: RequestEnv): Promise<UploadStsConfig | null> {
  const url = new URL('https://www.douyin.com/aweme/v1/web/im/upload/config/v2');
  const params: Record<string, string> = {
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    update_version_code: '170400',
    pc_client_type: '1',
    pc_libra_divert: 'Windows',
    version_code: '170400',
    version_name: '17.4.0',
    cookie_enabled: 'true',
    screen_width: '1400',
    screen_height: '900',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Chrome',
    browser_version: '130.0.0.0',
    browser_online: 'true',
    engine_name: 'Blink',
    engine_version: '130.0.0.0',
    os_name: 'Windows',
    os_version: '10',
    device_memory: '16',
    platform: 'PC',
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    'user-agent': env.userAgent || DEFAULT_UA,
    cookie: env.cookie,
    origin: 'https://www.douyin.com',
    referer: 'https://www.douyin.com/',
  };

  log.info('getUploadConfig: 获取 STS 凭证');
  try {
    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      log.error(`getUploadConfig: HTTP ${res.status}`);
      return null;
    }
    const j = (await res.json()) as {
      status_code?: number;
      public_image_config_v2?: {
        access_key_id: string;
        secret_access_key: string;
        session_token: string;
        space_name: string;
        expire_at: number;
      };
    };
    const cfg = j.public_image_config_v2;
    if (!cfg?.access_key_id) {
      log.error(`getUploadConfig: 响应无 STS 凭证 (status_code=${j.status_code})`);
      return null;
    }
    // session_token 可能带 "|expire_at" 后缀（v2 接口），实际发送时需去掉
    const sessionToken = cfg.session_token.split('|')[0];
    log.info(`getUploadConfig: 成功 space=${cfg.space_name} expire=${cfg.expire_at}`);
    return {
      accessKeyId: cfg.access_key_id,
      secretAccessKey: cfg.secret_access_key,
      sessionToken,
      spaceName: cfg.space_name,
      expireAt: cfg.expire_at,
    };
  } catch (e) {
    log.error('getUploadConfig 异常', e);
    return null;
  }
}

/**
 * AWS4-HMAC-SHA256 签名（用于 vod.bytedanceapi.com）
 */
function aws4Sign(
  method: string,
  url: URL,
  sts: UploadStsConfig,
  body: string,
  extraHeaders: Record<string, string> = {},
): { authorization: string; headers: Record<string, string> } {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);

  const sortedParams = Array.from(url.searchParams.entries())
    .filter(([k]) => k !== '')
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalQuery = sortedParams
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const signHeaders: Record<string, string> = {
    'x-amz-date': amzDate,
    'x-amz-security-token': sts.sessionToken,
    ...extraHeaders,
  };
  const sortedHeaderKeys = Object.keys(signHeaders).sort();
  const canonicalHeaders = sortedHeaderKeys
    .map((k) => `${k}:${signHeaders[k]}\n`)
    .join('');
  const signedHeaders = sortedHeaderKeys.join(';');

  const payloadHash = crypto
    .createHash('sha256')
    .update(body, 'utf-8')
    .digest('hex');

  const canonicalRequest = [
    method.toUpperCase(),
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const hashedCanonicalRequest = crypto
    .createHash('sha256')
    .update(canonicalRequest, 'utf-8')
    .digest('hex');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    hashedCanonicalRequest,
  ].join('\n');

  const kDate = hmacSha256('AWS4' + sts.secretAccessKey, dateStamp);
  const kRegion = hmacSha256(kDate, REGION);
  const kService = hmacSha256(kRegion, SERVICE);
  const kSigning = hmacSha256(kService, 'aws4_request');

  const signature = crypto
    .createHmac('sha256', kSigning)
    .update(stringToSign, 'utf-8')
    .digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${sts.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { authorization, headers: signHeaders };
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data, 'utf-8').digest();
}

/**
 * ApplyUploadInner - 申请上传
 */
export async function applyUploadInner(
  sts: UploadStsConfig,
  fileSize: number,
): Promise<ApplyUploadResult | null> {
  const url = new URL(VOD_API_BASE + '/');
  url.searchParams.set('Action', 'ApplyUploadInner');
  url.searchParams.set('Version', '2020-11-19');
  url.searchParams.set('SpaceName', sts.spaceName);
  url.searchParams.set('FileType', 'image');
  url.searchParams.set('IsInner', '1');
  url.searchParams.set('NeedFallback', 'true');
  url.searchParams.set('FileSize', String(fileSize));
  url.searchParams.set('s', 'dydsb2obmo');

  const { authorization, headers: signHeaders } = aws4Sign('GET', url, sts, '');

  const reqHeaders: Record<string, string> = {
    accept: '*/*',
    'user-agent': DEFAULT_UA,
    origin: 'https://www.douyin.com',
    referer: 'https://www.douyin.com/',
    authorization,
    ...signHeaders,
  };

  log.info(`applyUploadInner: fileSize=${fileSize} space=${sts.spaceName}`);
  try {
    const res = await fetch(url.toString(), { headers: reqHeaders });
    if (!res.ok) {
      log.error(`applyUploadInner: HTTP ${res.status}`);
      return null;
    }
    const j = (await res.json()) as {
      ResponseMetadata?: { Error?: { Code?: string; Message?: string } };
      Result?: {
        UploadAddress?: {
          StoreInfos?: Array<{
            StoreUri: string;
            Auth: string;
            UploadID: string;
            UploadHeader?: Record<string, string> | null;
            StorageHeader?: Record<string, string> | null;
          }>;
          UploadHosts?: string[];
          SessionKey: string;
        };
      };
    };
    if (j.ResponseMetadata?.Error) {
      log.error(`applyUploadInner: ${j.ResponseMetadata.Error.Code} - ${j.ResponseMetadata.Error.Message}`);
      return null;
    }
    const addr = j.Result?.UploadAddress;
    const store = addr?.StoreInfos?.[0];
    if (!store || !addr) {
      log.error('applyUploadInner: 响应无 StoreInfos');
      return null;
    }
    const uploadHost = addr.UploadHosts?.[0] || 'tos-d-x-hl.douyin.com';
    log.info(`applyUploadInner: 成功 storeUri=${store.StoreUri} uploadHost=${uploadHost}`);
    return {
      storeUri: store.StoreUri,
      auth: store.Auth,
      uploadId: store.UploadID,
      uploadHost,
      sessionKey: addr.SessionKey,
      storageHeader: store.StorageHeader || undefined,
    };
  } catch (e) {
    log.error('applyUploadInner 异常', e);
    return null;
  }
}

/**
 * 上传图片到 TOS
 */
export async function uploadToTos(
  applyResult: ApplyUploadResult,
  imageBytes: Buffer,
  userId: string,
): Promise<boolean> {
  const uploadUrl = `https://${applyResult.uploadHost}/upload/v1/${applyResult.storeUri}`;
  const crc32 = crc32Hex(imageBytes);

  const headers: Record<string, string> = {
    accept: '*/*',
    'content-type': 'application/octet-stream',
    'user-agent': DEFAULT_UA,
    origin: 'https://www.douyin.com',
    referer: 'https://www.douyin.com/',
    authorization: applyResult.auth,
    'content-crc32': crc32,
    'content-length': String(imageBytes.length),
    'content-disposition': 'attachment; filename="undefined"',
    'x-storage-u': userId,
  };

  log.info(`uploadToTos: url=${uploadUrl} size=${imageBytes.length}B crc32=${crc32}`);
  try {
    const res = await fetch(uploadUrl, {
      method: 'POST',
      headers,
      body: new Uint8Array(imageBytes),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.error(`uploadToTos: HTTP ${res.status} ${text.slice(0, 200)}`);
      return false;
    }
    const j = (await res.json()) as { code?: number; message?: string; data?: { crc32?: string } };
    if (j.code !== 2000) {
      log.error(`uploadToTos: code=${j.code} message=${j.message}`);
      return false;
    }
    log.info(`uploadToTos: 成功 crc32=${j.data?.crc32}`);
    return true;
  } catch (e) {
    log.error('uploadToTos 异常', e);
    return false;
  }
}

/**
 * CommitUploadInner - 提交上传，获取加密信息
 */
export async function commitUploadInner(
  sts: UploadStsConfig,
  applyResult: ApplyUploadResult,
): Promise<CommitUploadResult | null> {
  const url = new URL(VOD_API_BASE + '/');
  url.searchParams.set('Action', 'CommitUploadInner');
  url.searchParams.set('Version', '2020-11-19');
  url.searchParams.set('SpaceName', sts.spaceName);

  const body = JSON.stringify({
    SessionKey: applyResult.sessionKey,
    Functions: [
      {
        name: 'Encryption',
        input: {
          Config: { copies: 'cipher_v2' },
          PolicyParams: { 'policy-set': 'check,thumb,medium,large' },
        },
      },
    ],
  });

  const { authorization, headers: signHeaders } = aws4Sign('POST', url, sts, body, {
    'x-amz-content-sha256': crypto.createHash('sha256').update(body, 'utf-8').digest('hex'),
  });

  const reqHeaders: Record<string, string> = {
    accept: '*/*',
    'content-type': 'text/plain;charset=UTF-8',
    'user-agent': DEFAULT_UA,
    origin: 'https://www.douyin.com',
    referer: 'https://www.douyin.com/',
    authorization,
    ...signHeaders,
  };

  log.info('commitUploadInner: 提交上传');
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: reqHeaders,
      body,
    });
    if (!res.ok) {
      log.error(`commitUploadInner: HTTP ${res.status}`);
      return null;
    }
    const j = (await res.json()) as {
      ResponseMetadata?: { Error?: { Code?: string; Message?: string } };
      Result?: {
        Results?: Array<{
          Uri: string;
          UriStatus: number;
          Encryption?: {
            Uri: string;
            SecretKey: string;
            Algorithm: string;
            Version: string;
            SourceMd5: string;
            Extra?: {
              content_type?: string;
              img_format?: string;
              img_width?: string;
              img_height?: string;
              img_size?: string;
            };
          };
        }>;
      };
    };
    if (j.ResponseMetadata?.Error) {
      log.error(`commitUploadInner: ${j.ResponseMetadata.Error.Code} - ${j.ResponseMetadata.Error.Message}`);
      return null;
    }
    const result = j.Result?.Results?.[0];
    if (!result?.Encryption) {
      log.error('commitUploadInner: 响应无 Encryption 信息');
      return null;
    }
    const enc = result.Encryption;
    const extra = enc.Extra || {};
    log.info(
      `commitUploadInner: 成功 oid=${enc.Uri} md5=${enc.SourceMd5} ` +
      `${extra.img_width || '?'}x${extra.img_height || '?'} ${extra.img_format || '?'}`,
    );
    return {
      uri: result.Uri,
      encryptionUri: enc.Uri,
      secretKey: enc.SecretKey,
      algorithm: enc.Algorithm,
      sourceMd5: enc.SourceMd5,
      imgWidth: extra.img_width ? parseInt(extra.img_width, 10) : 0,
      imgHeight: extra.img_height ? parseInt(extra.img_height, 10) : 0,
      imgSize: extra.img_size ? parseInt(extra.img_size, 10) : 0,
      imgFormat: extra.img_format || 'jpeg',
    };
  } catch (e) {
    log.error('commitUploadInner 异常', e);
    return null;
  }
}

/** 计算 CRC32（使用 Node 内置 zlib.crc32()） */
function crc32Hex(buf: Buffer): string {
  return zlib.crc32(buf).toString(16).padStart(8, '0');
}

/**
 * 一键上传图片（封装完整流程）
 *
 * 依次执行：getUploadConfig → applyUploadInner → uploadToTos → commitUploadInner
 * 返回 CommitUploadResult（含 oid/skey/md5，可直接构造图片消息发送）。
 *
 * @param env 请求环境（只需 cookie + userId）
 * @param imageBytes 图片字节
 * @param userId 当前用户 uid（用于 x-storage-u 头）
 */
export async function uploadImage(
  env: RequestEnv,
  imageBytes: Buffer,
  userId: string,
): Promise<CommitUploadResult | null> {
  const sts = await getUploadConfig(env);
  if (!sts) return null;

  const apply = await applyUploadInner(sts, imageBytes.length);
  if (!apply) return null;

  const ok = await uploadToTos(apply, imageBytes, userId);
  if (!ok) {
    log.error('uploadImage: 上传图片字节失败');
    return null;
  }

  const commit = await commitUploadInner(sts, apply);
  if (!commit) return null;

  log.info(
    `uploadImage: 完整流程成功 oid=${commit.encryptionUri} ` +
    `${commit.imgWidth}x${commit.imgHeight} ${commit.imgSize}B`,
  );
  return commit;
}
