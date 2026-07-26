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
import { createLogger } from '../utils/logger.js';
import { DEFAULT_UA } from './imapi.js';
const log = createLogger('tos');
const VOD_API_BASE = 'https://vod.bytedanceapi.com';
const REGION = 'cn-north-1';
const SERVICE = 'vod';
/**
 * 获取上传配置（STS 凭证）
 *
 * GET /aweme/v1/web/im/upload/config/v2
 * 仅需 Cookie（实测与 user/info/ 等接口一致，无需 a_bogus/msToken 签名）。
 */
export async function getUploadConfig(env) {
    const url = new URL('https://www.douyin.com/aweme/v1/web/im/upload/config/v2');
    const params = {
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
    for (const [k, v] of Object.entries(params))
        url.searchParams.set(k, v);
    const headers = {
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
        const j = (await res.json());
        const cfg = j.public_image_config_v2;
        if (!cfg?.access_key_id) {
            log.error(`getUploadConfig: 响应无 STS 凭证 (status_code=${j.status_code})`);
            return null;
        }
        log.info(`getUploadConfig: 成功 space=${cfg.space_name} expire=${cfg.expire_at}`);
        return {
            accessKeyId: cfg.access_key_id,
            secretAccessKey: cfg.secret_access_key,
            sessionToken: cfg.session_token,
            spaceName: cfg.space_name,
            expireAt: cfg.expire_at,
        };
    }
    catch (e) {
        log.error('getUploadConfig 异常', e);
        return null;
    }
}
/**
 * AWS4-HMAC-SHA256 签名（用于 vod.bytedanceapi.com）
 *
 * 算法：
 *   1. 构造 CanonicalRequest
 *   2. 构造 StringToSign
 *   3. 派生 SigningKey
 *   4. 计算 Signature
 */
function aws4Sign(method, url, sts, body, extraHeaders = {}) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '') + 'Z';
    const dateStamp = amzDate.slice(0, 8);
    // 按 ASCII 字节序排序 query 参数
    const sortedParams = Array.from(url.searchParams.entries())
        .filter(([k]) => k !== '') // 过滤空 key
        .sort((a, b) => a[0].localeCompare(b[0]));
    const canonicalQuery = sortedParams
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
    // 构造签名 headers（必须小写）
    const signHeaders = {
        'x-amz-date': amzDate,
        'x-amz-security-token': sts.sessionToken,
        ...extraHeaders,
    };
    // 按 key 排序
    const sortedHeaderKeys = Object.keys(signHeaders).sort();
    const canonicalHeaders = sortedHeaderKeys
        .map((k) => `${k}:${signHeaders[k]}\n`)
        .join('');
    const signedHeaders = sortedHeaderKeys.join(';');
    // 计算 body hash
    const payloadHash = crypto
        .createHash('sha256')
        .update(body, 'utf-8')
        .digest('hex');
    // CanonicalRequest
    const canonicalRequest = [
        method.toUpperCase(),
        url.pathname,
        canonicalQuery,
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join('\n');
    // StringToSign
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
    // 派生 SigningKey
    const kDate = hmacSha256('AWS4' + sts.secretAccessKey, dateStamp);
    const kRegion = hmacSha256(kDate, REGION);
    const kService = hmacSha256(kRegion, SERVICE);
    const kSigning = hmacSha256(kService, 'aws4_request');
    // Signature
    const signature = crypto
        .createHmac('sha256', kSigning)
        .update(stringToSign, 'utf-8')
        .digest('hex');
    const authorization = `AWS4-HMAC-SHA256 Credential=${sts.accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return { authorization, headers: signHeaders };
}
function hmacSha256(key, data) {
    return crypto.createHmac('sha256', key).update(data, 'utf-8').digest();
}
/**
 * ApplyUploadInner - 申请上传
 *
 * GET vod.bytedanceapi.com?Action=ApplyUploadInner&Version=2020-11-19&SpaceName=zhenzhen&...
 * 返回 StoreUri、JWT Auth、UploadID、SessionKey。
 */
export async function applyUploadInner(sts, fileSize) {
    const url = new URL(VOD_API_BASE + '/');
    url.searchParams.set('Action', 'ApplyUploadInner');
    url.searchParams.set('Version', '2020-11-19');
    url.searchParams.set('SpaceName', sts.spaceName);
    url.searchParams.set('FileType', 'image');
    url.searchParams.set('IsInner', '1');
    url.searchParams.set('NeedFallback', 'true');
    url.searchParams.set('FileSize', String(fileSize));
    url.searchParams.set('s', 'dydsb2obmo');
    // GET 请求无 body，签名的 payload hash 为空字符串的 SHA256
    const { authorization, headers: signHeaders } = aws4Sign('GET', url, sts, '');
    const reqHeaders = {
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
        const j = (await res.json());
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
    }
    catch (e) {
        log.error('applyUploadInner 异常', e);
        return null;
    }
}
/**
 * 上传图片到 TOS
 *
 * POST {uploadHost}/upload/v1/{StoreUri}
 * Headers: authorization=JWT, content-crc32, x-storage-u
 * Body: 原始图片字节
 */
export async function uploadToTos(applyResult, imageBytes, userId) {
    const uploadUrl = `https://${applyResult.uploadHost}/upload/v1/${applyResult.storeUri}`;
    const crc32 = crc32Hex(imageBytes);
    const headers = {
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
        const j = (await res.json());
        if (j.code !== 2000) {
            log.error(`uploadToTos: code=${j.code} message=${j.message}`);
            return false;
        }
        log.info(`uploadToTos: 成功 crc32=${j.data?.crc32}`);
        return true;
    }
    catch (e) {
        log.error('uploadToTos 异常', e);
        return false;
    }
}
/**
 * CommitUploadInner - 提交上传，获取加密信息
 *
 * POST vod.bytedanceapi.com?Action=CommitUploadInner&Version=2020-11-19&SpaceName=zhenzhen
 * Body: JSON { SessionKey, Functions }
 * 返回 Encryption.Uri(oid), SecretKey(skey), SourceMd5(md5), Extra(尺寸/格式)
 */
export async function commitUploadInner(sts, applyResult) {
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
    // POST 请求需要签名 body 的 SHA256
    const { authorization, headers: signHeaders } = aws4Sign('POST', url, sts, body, {
        'x-amz-content-sha256': crypto.createHash('sha256').update(body, 'utf-8').digest('hex'),
    });
    const reqHeaders = {
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
        const j = (await res.json());
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
        log.info(`commitUploadInner: 成功 oid=${enc.Uri} md5=${enc.SourceMd5} ` +
            `${extra.img_width || '?'}x${extra.img_height || '?'} ${extra.img_format || '?'}`);
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
    }
    catch (e) {
        log.error('commitUploadInner 异常', e);
        return null;
    }
}
/**
 * 计算 CRC32（与 TOS 服务端校验一致）
 * 使用 IEEE 802.3 多项式（与 zlib crc32 相同）
 */
function crc32Hex(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    // 转为无符号 32 位，再转 hex（小写，无前缀）
    return (crc >>> 0).toString(16).padStart(8, '0');
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
export async function uploadImage(env, imageBytes, userId) {
    // 1. 获取 STS 凭证
    const sts = await getUploadConfig(env);
    if (!sts)
        return null;
    // 2. 申请上传
    const apply = await applyUploadInner(sts, imageBytes.length);
    if (!apply)
        return null;
    // 3. 上传图片字节
    const ok = await uploadToTos(apply, imageBytes, userId);
    if (!ok) {
        log.error('uploadImage: 上传图片字节失败');
        return null;
    }
    // 4. 提交上传，获取加密信息
    const commit = await commitUploadInner(sts, apply);
    if (!commit)
        return null;
    log.info(`uploadImage: 完整流程成功 oid=${commit.encryptionUri} ` +
        `${commit.imgWidth}x${commit.imgHeight} ${commit.imgSize}B`);
    return commit;
}
