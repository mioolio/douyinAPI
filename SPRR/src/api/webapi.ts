/**
 * 抖音 Web API 客户端（JSON 接口）
 *
 * 与 imapi.ts 不同，这里调用 www.douyin.com 的 JSON 接口。
 *
 * 关键发现（抓包验证）：/aweme/v1/web/im/user/info/ 仅需 Cookie 即可批量获取 nickname，
 * 无需 a_bogus/msToken/bd-ticket-guard 等签名。网页端 IM 就是通过这个接口
 * 在渲染会话列表时把 sec_uid 解析成 nickname 的。
 *
 * 请求：
 *   POST /aweme/v1/web/im/user/info/
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: sec_user_ids=<URL编码的JSON数组，最多50个>
 *   Headers: cookie, referer, user-agent
 *
 * 响应：
 *   { data: [{ nickname, sec_uid, uid, avatar_*, signature, ... }], status_code: 0 }
 */

import { createLogger } from '../utils/logger.js';
import { DEFAULT_UA, type RequestEnv } from './imapi.js';
import { sign as signRequest, extractMsToken, parseCookieValue } from '../crypto/signature.js';

const log = createLogger('webapi');

const WEB_API_BASE = 'https://www.douyin.com/aweme/v1/web/im';

/** 用户信息（来自 /aweme/v1/web/im/user/info/） */
export interface WebUserInfo {
  uid: string;
  secUid: string;
  nickname: string;
  remarkName?: string;
  signature?: string;
  avatarThumb?: string;
}

/** 加密图片（阅后即焚）解密结果（来自 /aweme/v1/web/im/read_once/detail） */
export interface ReadOnceImageInfo {
  /** 明文 URI（如 tos-cn-o-00061/uploadv2_xxx），可用于 batch_build_image 刷新签名 */
  oid: string;
  /** 大图签名 URL（直接可访问，有 expires） */
  largeUrl: string;
  /** 中图签名 URL */
  mediumUrl?: string;
  /** 原图签名 URL */
  originUrl?: string;
  /** 缩略图签名 URL */
  thumbUrl?: string;
  /** 图片 MD5 */
  md5?: string;
  /** 数据大小（字节） */
  dataSize?: number;
  /** 发送者 uid */
  senderId?: string;
  /** skey（用于 batch_build_image 等接口） */
  skey?: string;
}

/**
 * 获取加密图片（阅后即焚）的真实图片 URL
 *
 * 关键发现（抓包+实测验证）：
 * - 接口路径：GET /aweme/v1/web/im/read_once/detail
 * - 仅需 Cookie，无需 a_bogus/msToken 签名
 * - 服务器自己存着原图，"加密"只是访问控制
 * - 每条 read_once 消息只能查看一次：首次调用返回 show_once_info，之后返回空
 * - show_once_info 是字符串化的 JSON，需二次 parse
 *
 * @param env 请求环境（只需 cookie）
 * @param msgId 消息 ID（int64，必须用 string 传参避免精度丢失）
 * @param conversationShortId 会话 short_id（int64，string 传参）
 * @returns 图片信息；若消息已被查看过或失败，返回 null
 */
export async function getReadOnceImage(
  env: RequestEnv,
  msgId: string,
  conversationShortId: string,
): Promise<ReadOnceImageInfo | null> {
  const url = new URL(`${WEB_API_BASE}/read_once/detail`);
  const params: Record<string, string> = {
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    msg_id: msgId,
    conversation_short_id: conversationShortId,
    update_version_code: '170400',
    pc_client_type: '1',
    pc_libra_divert: 'Windows',
    support_h265: '1',
    support_dash: '0',
    cpu_core_num: '12',
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
    downlink: '10',
    effective_type: '4g',
    round_trip_time: '50',
  };
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'user-agent': env.userAgent || DEFAULT_UA,
    cookie: env.cookie,
    origin: 'https://www.douyin.com',
    referer: 'https://www.douyin.com/',
  };

  log.info(`getReadOnceImage: msg_id=${msgId} conv=${conversationShortId}`);
  try {
    const res = await fetch(url.toString(), { method: 'GET', headers });
    if (!res.ok) {
      log.error(`getReadOnceImage: HTTP ${res.status}`);
      return null;
    }
    const j = (await res.json()) as {
      status_code?: number;
      show_once_info?: string;
    };
    if (j.status_code !== 0) {
      log.warn(`getReadOnceImage: status_code=${j.status_code}`);
      return null;
    }
    if (!j.show_once_info) {
      // 消息已被查看过（read_once 只能查看一次）
      log.info(`getReadOnceImage: 消息已被查看过，返回空`);
      return null;
    }
    // show_once_info 是字符串化的 JSON，需二次 parse
    const info = JSON.parse(j.show_once_info) as {
      resource_url?: {
        oid?: string;
        large_url_list?: string[];
        medium_url_list?: string[];
        origin_url_list?: string[];
        thumb_url_list?: string[];
        md5?: string;
        data_size?: number;
        skey?: string;
      };
      sender_id?: string | number;
    };
    const ru = info.resource_url;
    if (!ru || !ru.large_url_list?.length) {
      log.warn(`getReadOnceImage: show_once_info 内无 large_url_list`);
      return null;
    }
    const result: ReadOnceImageInfo = {
      oid: ru.oid || '',
      largeUrl: ru.large_url_list[0],
      mediumUrl: ru.medium_url_list?.[0],
      originUrl: ru.origin_url_list?.[0],
      thumbUrl: ru.thumb_url_list?.[0],
      md5: ru.md5,
      dataSize: ru.data_size,
      senderId: info.sender_id != null ? String(info.sender_id) : undefined,
      skey: ru.skey,
    };
    log.info(
      `getReadOnceImage: 成功 oid=${result.oid} size=${result.dataSize || '?'}B`,
    );
    return result;
  } catch (e) {
    log.error(`getReadOnceImage 异常`, e);
    return null;
  }
}

/**
 * 用 oid 换取图片签名 URL（batch_build_image 接口）
 *
 * 用于：自己发送的图片消息中只有 oid 没有 URL 的情况。
 * 仅需 Cookie，无需 a_bogus/msToken 签名。
 *
 * @param env 请求环境（只需 cookie）
 * @param oid 图片 oid（如 tos-cn-o-00061/uploadv2_xxx）
 * @param format 图片尺寸模板，默认 tplv-x-get:large.image
 * @returns 签名 URL 列表；失败返回空数组
 */
export async function buildImageUrl(
  env: RequestEnv,
  oid: string,
  format: string = 'tplv-x-get:large.image',
): Promise<string[]> {
  const url = new URL('https://www.douyin.com/aweme/v1/web/privacy/batch_build_image/');
  const params: Record<string, string> = {
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    pc_client_type: '1',
    update_version_code: '170400',
    version_code: '170400',
    version_name: '17.4.0',
    cookie_enabled: 'true',
    platform: 'PC',
  };
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const body = JSON.stringify({
    convert_params: [{ uri: oid, format, tpl: '%s://%v/%v~%v' }],
  });

  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json; charset=UTF-8',
    'user-agent': env.userAgent || DEFAULT_UA,
    cookie: env.cookie,
    origin: 'https://www.douyin.com',
    referer: 'https://www.douyin.com/',
    'x-secsdk-csrf-token': 'DOWNGRADE',
  };

  try {
    const res = await fetch(url.toString(), { method: 'POST', headers, body });
    if (!res.ok) {
      log.error(`buildImageUrl: HTTP ${res.status}`);
      return [];
    }
    const j = (await res.json()) as {
      status_code?: number;
      data?: { pack_results?: Array<{ UrlList?: string[] }> };
    };
    const urls = j.data?.pack_results?.[0]?.UrlList;
    if (!urls || urls.length === 0) {
      log.warn(`buildImageUrl: 无 UrlList (status_code=${j.status_code})`);
      return [];
    }
    return urls;
  } catch (e) {
    log.error(`buildImageUrl 异常`, e);
    return [];
  }
}

/**
 * 批量获取用户信息（nickname 等）
 *
 * 仅需 Cookie，无需 a_bogus/msToken 签名。
 * 内部按 50 个一批分组（接口上限）。
 *
 * @param env 请求环境（只需 cookie）
 * @param secUids sec_uid 列表
 * @returns 用户信息列表（按 secUid 索引）
 */
export async function getUserInfoBatch(
  env: RequestEnv,
  secUids: string[],
): Promise<WebUserInfo[]> {
  // 去重 + 过滤空值
  const unique = Array.from(new Set(secUids.filter((s) => s && s.length > 0)));
  if (unique.length === 0) return [];

  const results: WebUserInfo[] = [];
  const batchSize = 50;
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    const batchResults = await fetchUserInfoBatch(env, batch);
    results.push(...batchResults);
  }
  return results;
}

/** 构造 sec_uid -> WebUserInfo 的映射，便于查找 */
export async function getUserInfoMap(
  env: RequestEnv,
  secUids: string[],
): Promise<Map<string, WebUserInfo>> {
  const list = await getUserInfoBatch(env, secUids);
  const map = new Map<string, WebUserInfo>();
  for (const u of list) map.set(u.secUid, u);
  return map;
}

/**
 * 表情贴纸收藏/取消收藏（/aweme/v1/web/im/resource/sticker/collect/）
 *
 * 抓包验证（0374_POST_9ee5ebfcf25e）：
 *   - POST /aweme/v1/web/im/resource/sticker/collect/
 *   - 需要 a_bogus + msToken 签名（同时需 verifyFp/fp，来自 cookie 中的 s_v_web_id）
 *   - Body: "{}"（固定空 JSON）
 *   - Headers: x-secsdk-csrf-token: DOWNGRADE, content-type: application/json;charset=UTF-8
 *   - 关键参数：aid=1128&app_id=1128, action=1（收藏）, sticker_ids=[<id>],
 *     sticker_uri, sticker_url, resource_id（可能为负数）, sticker_type=1
 *   - 响应：status_code=0 + success_items[]（含 animate_url/static_url 等元数据）
 *
 * a_bogus 签名由 src/crypto/signature.ts 纯算生成（基于 params + body），
 * msToken / verifyFp 从 cookie 中提取。
 *
 * @param env 请求环境
 * @param sticker 表情贴纸信息
 * @param action 1=收藏, 0=取消收藏
 * @returns 是否成功
 */
export async function collectSticker(
  env: RequestEnv,
  sticker: {
    /** 表情 ID（sticker_ids 数组中唯一元素） */
    stickerId: string;
    /** 表情 URI（如 "ies.fe.effect/xxx" 或 "tos-cn-o-0812/xxx"） */
    stickerUri: string;
    /** 签名 URL（sticker_url 参数） */
    stickerUrl: string;
    /** 资源 ID（resource_id 参数，可能为负数） */
    resourceId: string;
    /** 贴纸类型（sticker_type 参数，默认 1；响应中可能返回 2，与请求参数不同字段含义） */
    stickerType?: number;
  },
  action: number,
): Promise<boolean> {
  const url = new URL('https://www.douyin.com/aweme/v1/web/im/resource/sticker/collect/');
  // verifyFp/fp 来自 cookie 中的 s_v_web_id（抓包验证）
  const verifyFp = parseCookieValue(env.cookie, 's_v_web_id') || '';
  const msToken = extractMsToken(env.cookie);
  // 构造 params（含 msToken / verifyFp，但不含 a_bogus —— a_bogus 基于这些 params 计算）
  const params: Record<string, string> = {
    device_platform: 'webapp',
    aid: '1128',
    channel: 'channel_pc_web',
    app_id: '1128',
    isUseBigNumber: 'true',
    action: String(action),
    sticker_ids: JSON.stringify([sticker.stickerId]),
    sticker_uri: sticker.stickerUri,
    sticker_url: sticker.stickerUrl,
    resource_id: sticker.resourceId,
    sticker_type: String(sticker.stickerType ?? 1),
    pc_client_type: '1',
    pc_libra_divert: 'Windows',
    update_version_code: '170400',
    support_h265: '1',
    support_dash: '0',
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
    cpu_core_num: '12',
    device_memory: '16',
    platform: 'PC',
    downlink: '10',
    effective_type: '4g',
    round_trip_time: '100',
    webid: env.identitySecurityDeviceId || '0',
  };
  if (msToken) params.msToken = msToken;
  if (verifyFp) {
    params.verifyFp = verifyFp;
    params.fp = verifyFp;
  }

  // 生成 a_bogus 签名（基于 params + body='{}'）
  const { aBogus } = signRequest({
    url: '/aweme/v1/web/im/resource/sticker/collect/',
    params,
    method: 'POST',
    userAgent: env.userAgent || DEFAULT_UA,
    body: '{}',
    cookie: env.cookie,
  });
  if (aBogus) params.a_bogus = aBogus;

  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json;charset=UTF-8',
    'user-agent': env.userAgent || DEFAULT_UA,
    cookie: env.cookie,
    origin: 'https://www.douyin.com',
    referer: 'https://www.douyin.com/chat?isPopup=1',
    'x-secsdk-csrf-token': 'DOWNGRADE',
  };

  log.info(`collectSticker: action=${action} stickerId=${sticker.stickerId} aBogus=${aBogus ? aBogus.length + 'chars' : 'none'}`);
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body: '{}',
    });
    if (!res.ok) {
      log.error(`collectSticker: HTTP ${res.status}`);
      return false;
    }
    const j = (await res.json()) as { status_code?: number };
    if (j.status_code !== 0) {
      log.warn(`collectSticker: status_code=${j.status_code}`);
      return false;
    }
    log.info(`collectSticker: 成功`);
    return true;
  } catch (e) {
    log.error(`collectSticker 异常`, e);
    return false;
  }
}

/**
 * 视频详情信息（来自 /aweme/v1/web/multi/aweme/detail/）
 */
export interface VideoDetailInfo {
  /** 视频 ID（aweme_id） */
  awemeId: string;
  /** 视频描述/标题 */
  desc?: string;
  /** 作者昵称 */
  authorNickname?: string;
  /** 作者 sec_uid */
  authorSecUid?: string;
  /** 作者 uid */
  authorUid?: string;
  /** 视频时长（秒） */
  duration?: number;
  /** 视频封面 URL */
  coverUrl?: string;
  /** 视频播放地址 */
  playUrl?: string;
  /** 点赞数 */
  diggCount?: number;
  /** 评论数 */
  commentCount?: number;
  /** 分享数 */
  shareCount?: number;
}

/**
 * 批量获取视频详情（/aweme/v1/web/multi/aweme/detail/）
 *
 * 抓包验证（0328_POST_879932445c2c）：
 *   - POST /aweme/v1/web/multi/aweme/detail/
 *   - 需要 a_bogus + msToken 签名
 *   - Body: "{}"（固定空 JSON）
 *   - 关键参数：aweme_ids=[<id>,...]（URL-encoded JSON 数组），origin_type=chat，
 *     request_source=3，conversation_short_id=<cid>
 *
 * a_bogus 签名由 src/crypto/signature.ts 纯算生成（基于 params + body），
 * msToken 从 cookie 中提取。
 *
 * @param env 请求环境
 * @param awemeIds 视频 ID 列表
 * @param conversationShortId 会话短 ID（用于上下文）
 * @returns 视频详情列表
 */
export async function getVideoDetail(
  env: RequestEnv,
  awemeIds: string[],
  conversationShortId: string,
): Promise<VideoDetailInfo[]> {
  const url = new URL('https://www.douyin.com/aweme/v1/web/multi/aweme/detail/');
  const msToken = extractMsToken(env.cookie);
  const verifyFp = parseCookieValue(env.cookie, 's_v_web_id') || '';
  // aweme_ids 必须是数字数组格式（无引号），但 aweme_id 超过 Number.MAX_SAFE_INTEGER，
  // 不能用 JSON.stringify(awemeIds.map(Number))（会丢精度），直接拼接保持原始字符串
  const params: Record<string, string> = {
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    aweme_ids: '[' + awemeIds.join(',') + ']',
    origin_type: 'chat',
    request_source: '3',
    conversation_short_id: conversationShortId,
    pc_client_type: '1',
    pc_libra_divert: 'Windows',
    update_version_code: '170400',
    support_h265: '1',
    support_dash: '0',
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
    cpu_core_num: '12',
    device_memory: '16',
    platform: 'PC',
    downlink: '10',
    effective_type: '4g',
    round_trip_time: '50',
    webid: env.identitySecurityDeviceId || '0',
  };
  if (msToken) params.msToken = msToken;
  if (verifyFp) {
    params.verifyFp = verifyFp;
    params.fp = verifyFp;
  }

  // 生成 a_bogus 签名（基于 params + body='{}'）
  const { aBogus } = signRequest({
    url: '/aweme/v1/web/multi/aweme/detail/',
    params,
    method: 'POST',
    userAgent: env.userAgent || DEFAULT_UA,
    body: '{}',
    cookie: env.cookie,
  });
  if (aBogus) params.a_bogus = aBogus;

  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json;charset=UTF-8',
    'user-agent': env.userAgent || DEFAULT_UA,
    cookie: env.cookie,
    origin: 'https://www.douyin.com',
    referer: 'https://www.douyin.com/chat?isPopup=1',
    'x-secsdk-csrf-token': 'DOWNGRADE',
  };

  log.info(`getVideoDetail: awemeIds=${awemeIds.length} conv=${conversationShortId}`);
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body: '{}',
    });
    if (!res.ok) {
      log.error(`getVideoDetail: HTTP ${res.status}`);
      return [];
    }
    const rawText = await res.text();
    log.debug(`getVideoDetail: response body=${rawText.slice(0, 500)}`);
    const j = JSON.parse(rawText) as {
      status_code?: number;
      status_msg?: string;
      aweme_details?: Array<{
        aweme_id?: string | number;
        desc?: string;
        author?: {
          nickname?: string;
          sec_uid?: string;
          uid?: string;
        };
        duration?: number;
        video?: {
          cover?: { url_list?: string[] };
          play_addr?: { url_list?: string[] };
        };
        statistics?: {
          digg_count?: number;
          comment_count?: number;
          share_count?: number;
        };
      }>;
      [k: string]: unknown;
    };
    if (j.status_code !== 0 || !Array.isArray(j.aweme_details)) {
      log.warn(`getVideoDetail: status_code=${j.status_code} msg=${j.status_msg || ''} keys=${Object.keys(j).join(',')}`);
      return [];
    }
    const results: VideoDetailInfo[] = [];
    for (const v of j.aweme_details) {
      if (!v.aweme_id) continue;
      results.push({
        awemeId: String(v.aweme_id),
        desc: v.desc,
        authorNickname: v.author?.nickname,
        authorSecUid: v.author?.sec_uid,
        authorUid: v.author?.uid,
        duration: v.duration,
        coverUrl: v.video?.cover?.url_list?.[0],
        playUrl: v.video?.play_addr?.url_list?.[0],
        diggCount: v.statistics?.digg_count,
        commentCount: v.statistics?.comment_count,
        shareCount: v.statistics?.share_count,
      });
    }
    log.info(`getVideoDetail: 成功获取 ${results.length}/${awemeIds.length} 个视频详情`);
    return results;
  } catch (e) {
    log.error(`getVideoDetail 异常`, e);
    return [];
  }
}

async function fetchUserInfoBatch(
  env: RequestEnv,
  secUids: string[],
): Promise<WebUserInfo[]> {
  const url = new URL(`${WEB_API_BASE}/user/info/`);
  // 基础 query 参数（与抓包样本一致，不含签名）
  const params: Record<string, string> = {
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    pc_client_type: '1',
    update_version_code: '170400',
    version_code: '170400',
    version_name: '17.4.0',
    cookie_enabled: 'true',
    browser_name: 'Chrome',
    browser_version: '130.0.0.0',
    webid: env.identitySecurityDeviceId || '0',
  };
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const body = `sec_user_ids=${encodeURIComponent(JSON.stringify(secUids))}`;

  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/x-www-form-urlencoded',
    'user-agent': env.userAgent || DEFAULT_UA,
    cookie: env.cookie,
    origin: 'https://www.douyin.com',
    referer: 'https://www.douyin.com/chat?isPopup=1',
    'accept-language': 'zh-CN,zh;q=0.9',
    'sec-ch-ua': '"Chromium";v="149", "Not)A;Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
  };

  log.info(`getUserInfoBatch: 查询 ${secUids.length} 个用户`);
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body,
    });
    if (!res.ok) {
      log.error(`getUserInfoBatch: HTTP ${res.status}`);
      return [];
    }
    const j = (await res.json()) as {
      status_code?: number;
      data?: Array<{
        uid?: string;
        sec_uid?: string;
        nickname?: string;
        remark_name?: string;
        signature?: string;
        avatar_thumb?: { url_list?: string[] };
      }>;
    };
    if (j.status_code !== 0 || !Array.isArray(j.data)) {
      log.warn(`getUserInfoBatch: status_code=${j.status_code}`);
      return [];
    }
    const results: WebUserInfo[] = [];
    for (const u of j.data) {
      if (!u.sec_uid || !u.nickname) continue;
      results.push({
        uid: u.uid || '',
        secUid: u.sec_uid,
        nickname: u.nickname,
        remarkName: u.remark_name || undefined,
        signature: u.signature || undefined,
        avatarThumb: u.avatar_thumb?.url_list?.[0],
      });
    }
    log.info(
      `getUserInfoBatch: 成功获取 ${results.length}/${secUids.length} 个用户信息`,
    );
    return results;
  } catch (e) {
    log.error(`getUserInfoBatch 异常`, e);
    return [];
  }
}

/* ----------------------------- 互动接口（视频详情/评论列表/评论发布） ----------------------------- */

/**
 * bd-ticket-guard 浏览器加密签名头集合
 *
 * 抓包分析（2026-07-26 interact 数据）：
 *   - bd-ticket-guard-client-data: base64 JSON，含 ts_sign + req_content + req_sign + timestamp
 *     ts_sign 来源于 cookie bd_ticket_guard_ts_sign_id（固定值）；
 *     req_sign 是浏览器 webmssdk.js 基于会话密钥 + path + timestamp 计算的 HMAC，
 *     同一接口在会话内复用（不每次重新计算）；
 *   - bd-ticket-guard-ree-public-key: 来自 cookie bd_ticket_guard_client_data 解码后的字段（固定值）；
 *   - x-tt-session-dtrait: 浏览器 mssdk.js 生成，会话级稳定。
 *
 * 纯算逆向非常复杂（ECDH + HMAC + 浏览器 SDK localStorage），
 * 实际使用时建议从浏览器抓包复制这三个头，作为参数传入。
 * 抓包样本表明同一接口的 req_sign 在会话内稳定，因此一次抓包可使用较长时间。
 */
export interface TicketGuardHeaders {
  /** bd-ticket-guard-client-data 请求头值（base64 字符串，从浏览器抓包复制） */
  clientData?: string;
  /** bd-ticket-guard-ree-public-key 请求头值（base64 字符串，从浏览器抓包复制） */
  reePublicKey?: string;
  /** x-tt-session-dtrait 请求头值（从浏览器抓包复制） */
  sessionDtrait?: string;
}

/**
 * 视频详情信息（来自 /aweme/v1/web/aweme/detail/）
 *
 * 与 VideoDetailInfo（multi/aweme/detail 批量接口）字段一致，但来自单查接口。
 * 用于通知来源视频解析（notice.awemeId → 视频详情）。
 */
export interface AwemeDetailInfo {
  awemeId: string;
  desc?: string;
  authorNickname?: string;
  authorSecUid?: string;
  authorUid?: string;
  duration?: number;
  coverUrl?: string;
  playUrl?: string;
  diggCount?: number;
  commentCount?: number;
  shareCount?: number;
  /** 鉴权 token（后续评论发布等接口需要） */
  authenticationToken?: string;
}

/**
 * 评论信息（来自 /aweme/v1/web/comment/list/）
 */
export interface CommentInfo {
  /** 评论 ID（cid） */
  commentId: string;
  /** 评论内容 */
  text: string;
  /** 视频 ID */
  awemeId: string;
  /** 创建时间（秒级时间戳） */
  createTime: number;
  /** 点赞数 */
  diggCount: number;
  /** 回复数 */
  replyCount: number;
  /** 评论者 uid */
  userId: string;
  /** 评论者 sec_uid */
  userSecUid: string;
  /** 评论者昵称 */
  userNickname: string;
  /** 被回复评论 ID（顶级评论为 '0'） */
  replyId: string;
  /** IP 归属地 */
  ipLabel?: string;
  /** 是否热门 */
  isHot?: boolean;
}

/**
 * 获取单个视频详情（/aweme/v1/web/aweme/detail/）
 *
 * 抓包验证（0040_GET_60265ea94064）：
 *   - GET /aweme/v1/web/aweme/detail/?aweme_id=xxx&request_source=600&origin_type=notice_modal
 *   - 需要 a_bogus + msToken + verifyFp 签名
 *   - 浏览器带 bd-ticket-guard-client-data 头，但实测 GET 接口对 ticket-guard 校验较宽松
 *   - 响应字段：aweme_detail.{desc, author, duration, video, statistics, authentication_token}
 *
 * @param env 请求环境
 * @param awemeId 视频 ID
 * @param ticketGuard 可选的 ticket-guard 头（GET 接口通常可省略）
 */
export async function getAwemeDetail(
  env: RequestEnv,
  awemeId: string,
  ticketGuard?: TicketGuardHeaders,
): Promise<AwemeDetailInfo | null> {
  const url = new URL('https://www.douyin.com/aweme/v1/web/aweme/detail/');
  const msToken = extractMsToken(env.cookie);
  const verifyFp = parseCookieValue(env.cookie, 's_v_web_id') || '';
  const params: Record<string, string> = {
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    aweme_id: awemeId,
    request_source: '600',
    origin_type: 'notice_modal',
    update_version_code: '170400',
    pc_client_type: '1',
    pc_libra_divert: 'Windows',
    support_h265: '1',
    support_dash: '1',
    cpu_core_num: '12',
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
    downlink: '10',
    effective_type: '4g',
    round_trip_time: '150',
    webid: env.identitySecurityDeviceId || '0',
  };
  if (msToken) params.msToken = msToken;
  if (verifyFp) {
    params.verifyFp = verifyFp;
    params.fp = verifyFp;
  }

  // 生成 a_bogus 签名（GET 请求 body 为空）
  const { aBogus } = signRequest({
    url: '/aweme/v1/web/aweme/detail/',
    params,
    method: 'GET',
    userAgent: env.userAgent || DEFAULT_UA,
    body: '',
    cookie: env.cookie,
  });
  if (aBogus) params.a_bogus = aBogus;

  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'user-agent': env.userAgent || DEFAULT_UA,
    cookie: env.cookie,
    origin: 'https://www.douyin.com',
    referer: 'https://www.douyin.com/',
  };
  // ticket-guard 可选（GET 接口实测通常不强制）
  if (ticketGuard?.clientData) headers['bd-ticket-guard-client-data'] = ticketGuard.clientData;
  if (ticketGuard?.reePublicKey) headers['bd-ticket-guard-ree-public-key'] = ticketGuard.reePublicKey;

  log.info(`getAwemeDetail: awemeId=${awemeId} aBogus=${aBogus ? aBogus.length + 'chars' : 'none'} ticketGuard=${ticketGuard?.clientData ? 'yes' : 'no'}`);
  try {
    const res = await fetch(url.toString(), { method: 'GET', headers });
    if (!res.ok) {
      log.error(`getAwemeDetail: HTTP ${res.status}`);
      return null;
    }
    const rawText = await res.text();
    log.debug(`getAwemeDetail: response head=${rawText.slice(0, 300)}`);
    const j = JSON.parse(rawText) as {
      status_code?: number;
      aweme_detail?: {
        aweme_id?: string | number;
        desc?: string;
        author?: { nickname?: string; sec_uid?: string; uid?: string };
        duration?: number;
        video?: {
          cover?: { url_list?: string[] };
          play_addr?: { url_list?: string[] };
        };
        statistics?: {
          digg_count?: number;
          comment_count?: number;
          share_count?: number;
        };
        authentication_token?: string;
      };
    };
    if (j.status_code !== 0 || !j.aweme_detail) {
      log.warn(`getAwemeDetail: status_code=${j.status_code}`);
      return null;
    }
    const a = j.aweme_detail;
    const result: AwemeDetailInfo = {
      awemeId: String(a.aweme_id || awemeId),
      desc: a.desc,
      authorNickname: a.author?.nickname,
      authorSecUid: a.author?.sec_uid,
      authorUid: a.author?.uid,
      duration: a.duration,
      coverUrl: a.video?.cover?.url_list?.[0],
      playUrl: a.video?.play_addr?.url_list?.[0],
      diggCount: a.statistics?.digg_count,
      commentCount: a.statistics?.comment_count,
      shareCount: a.statistics?.share_count,
      authenticationToken: a.authentication_token,
    };
    log.info(`getAwemeDetail: 成功 desc=${truncate(result.desc, 30)}`);
    return result;
  } catch (e) {
    log.error(`getAwemeDetail 异常`, e);
    return null;
  }
}

/**
 * 获取视频评论列表（/aweme/v1/web/comment/list/）
 *
 * 抓包验证（0050_GET_34cdfead8f6b）：
 *   - GET /aweme/v1/web/comment/list/?aweme_id=xxx&cursor=0&count=10&item_type=0
 *   - 需要 a_bogus + msToken + verifyFp 签名
 *   - 浏览器带 bd-ticket-guard-client-data 头，但 GET 接口对 ticket-guard 校验较宽松
 *   - 响应字段：status_code, comments[{cid, text, user, reply_id, digg_count, reply_comment_total, ...}], cursor, has_more, total
 *
 * @param env 请求环境
 * @param awemeId 视频 ID
 * @param opts 分页参数（cursor 默认 0，count 默认 10）
 * @param ticketGuard 可选的 ticket-guard 头
 */
export async function getCommentList(
  env: RequestEnv,
  awemeId: string,
  opts: { cursor?: number; count?: number } = {},
  ticketGuard?: TicketGuardHeaders,
): Promise<{ comments: CommentInfo[]; cursor: number; hasMore: boolean; total: number }> {
  const url = new URL('https://www.douyin.com/aweme/v1/web/comment/list/');
  const msToken = extractMsToken(env.cookie);
  const verifyFp = parseCookieValue(env.cookie, 's_v_web_id') || '';
  const cursor = opts.cursor ?? 0;
  const count = opts.count ?? 10;
  const params: Record<string, string> = {
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    aweme_id: awemeId,
    pc_img_format: 'webp',
    cursor: String(cursor),
    count: String(count),
    item_type: '0',
    insert_ids: '',
    whale_cut_token: '',
    cut_version: '1',
    rcFT: '',
    update_version_code: '170400',
    pc_client_type: '1',
    pc_libra_divert: 'Windows',
    support_h265: '1',
    support_dash: '1',
    cpu_core_num: '12',
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
    downlink: '10',
    effective_type: '4g',
    round_trip_time: '150',
    webid: env.identitySecurityDeviceId || '0',
  };
  if (msToken) params.msToken = msToken;
  if (verifyFp) {
    params.verifyFp = verifyFp;
    params.fp = verifyFp;
  }

  const { aBogus } = signRequest({
    url: '/aweme/v1/web/comment/list/',
    params,
    method: 'GET',
    userAgent: env.userAgent || DEFAULT_UA,
    body: '',
    cookie: env.cookie,
  });
  if (aBogus) params.a_bogus = aBogus;

  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'user-agent': env.userAgent || DEFAULT_UA,
    cookie: env.cookie,
    origin: 'https://www.douyin.com',
    referer: `https://www.douyin.com/?modal_id=${awemeId}`,
  };
  if (ticketGuard?.clientData) headers['bd-ticket-guard-client-data'] = ticketGuard.clientData;
  if (ticketGuard?.reePublicKey) headers['bd-ticket-guard-ree-public-key'] = ticketGuard.reePublicKey;

  log.info(`getCommentList: awemeId=${awemeId} cursor=${cursor} count=${count} ticketGuard=${ticketGuard?.clientData ? 'yes' : 'no'}`);
  try {
    const res = await fetch(url.toString(), { method: 'GET', headers });
    if (!res.ok) {
      log.error(`getCommentList: HTTP ${res.status}`);
      return { comments: [], cursor, hasMore: false, total: 0 };
    }
    const j = (await res.json()) as {
      status_code?: number;
      comments?: Array<{
        cid?: string;
        text?: string;
        aweme_id?: string | number;
        create_time?: number;
        digg_count?: number;
        reply_comment_total?: number;
        reply_id?: string;
        user?: {
          uid?: string;
          sec_uid?: string;
          nickname?: string;
        };
        ip_label?: string;
        is_hot?: boolean;
      }>;
      cursor?: number;
      has_more?: number;
      total?: number;
    };
    if (j.status_code !== 0 || !Array.isArray(j.comments)) {
      log.warn(`getCommentList: status_code=${j.status_code}`);
      return { comments: [], cursor, hasMore: false, total: j.total ?? 0 };
    }
    const comments: CommentInfo[] = [];
    for (const c of j.comments) {
      if (!c.cid) continue;
      comments.push({
        commentId: c.cid,
        text: c.text || '',
        awemeId: String(c.aweme_id || awemeId),
        createTime: c.create_time || 0,
        diggCount: c.digg_count ?? 0,
        replyCount: c.reply_comment_total ?? 0,
        userId: c.user?.uid || '',
        userSecUid: c.user?.sec_uid || '',
        userNickname: c.user?.nickname || '',
        replyId: c.reply_id || '0',
        ipLabel: c.ip_label,
        isHot: c.is_hot,
      });
    }
    log.info(`getCommentList: 获取 ${comments.length} 条评论 total=${j.total ?? 0} hasMore=${j.has_more === 1}`);
    return {
      comments,
      cursor: j.cursor ?? cursor + count,
      hasMore: j.has_more === 1,
      total: j.total ?? 0,
    };
  } catch (e) {
    log.error(`getCommentList 异常`, e);
    return { comments: [], cursor, hasMore: false, total: 0 };
  }
}

/**
 * 发布评论或回复评论（/aweme/v1/web/comment/publish）
 *
 * 抓包验证（0052_POST_4ee30eae99ab）：
 *   - POST /aweme/v1/web/comment/publish
 *   - Content-Type: application/x-www-form-urlencoded; charset=UTF-8
 *   - Body: aweme_id, text, reply_id（回复评论时传被回复评论 cid）, text_extra（@用户元数据数组）,
 *           comment_send_celltime, comment_video_celltime, one_level_comment_rank,
 *           paste_edit_method=non_paste
 *   - 必需签名头：bd-ticket-guard-client-data, bd-ticket-guard-ree-public-key, x-tt-session-dtrait
 *     （这三个头由浏览器 webmssdk.js/mssdk.js 生成，纯算逆向非常复杂，
 *      实际使用需从浏览器抓包复制，会话内稳定可复用）
 *   - 必需 cookie: x-secsdk-csrf-token: DOWNGRADE
 *   - 响应：status_code=0 + comment{cid,...} 表示成功
 *
 * @param env 请求环境
 * @param opts 评论参数
 * @param ticketGuard 必需的 ticket-guard 头集合（从浏览器抓包复制）
 */
export async function publishComment(
  env: RequestEnv,
  opts: {
    awemeId: string;
    text: string;
    /** 被回复评论 cid（回复顶级评论时传该评论 cid；发布顶级评论时不传或传 '0'） */
    replyId?: string;
    /** @用户元数据（text_extra 数组，每项含 user_id/sec_uid/type/start/end） */
    textExtra?: Array<{
      user_id: string;
      sec_uid: string;
      type: number;
      start: number;
      end: number;
    }>;
  },
  ticketGuard: TicketGuardHeaders,
): Promise<{ success: boolean; commentId?: string; raw?: unknown }> {
  if (!ticketGuard.clientData || !ticketGuard.reePublicKey || !ticketGuard.sessionDtrait) {
    log.error('publishComment: 缺少 ticket-guard 头（clientData/reePublicKey/sessionDtrait 必需，请从浏览器抓包复制）');
    return { success: false };
  }

  const url = new URL('https://www.douyin.com/aweme/v1/web/comment/publish');
  const msToken = extractMsToken(env.cookie);
  const verifyFp = parseCookieValue(env.cookie, 's_v_web_id') || '';
  const params: Record<string, string> = {
    app_name: 'aweme',
    enter_from: 'recommend',
    previous_page: 'recommend',
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    pc_client_type: '1',
    pc_libra_divert: 'Windows',
    update_version_code: '170400',
    support_h265: '1',
    support_dash: '1',
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
    cpu_core_num: '12',
    device_memory: '16',
    platform: 'PC',
    downlink: '10',
    effective_type: '4g',
    round_trip_time: '150',
    webid: env.identitySecurityDeviceId || '0',
  };
  if (msToken) params.msToken = msToken;
  if (verifyFp) {
    params.verifyFp = verifyFp;
    params.fp = verifyFp;
  }

  // 构造表单 body
  const formParams: Record<string, string> = {
    aweme_id: opts.awemeId,
    comment_send_celltime: String(Math.floor(Math.random() * 30000) + 5000),
    comment_video_celltime: String(Math.floor(Math.random() * 10000) + 1000),
    one_level_comment_rank: opts.replyId ? '1' : '-1',
    paste_edit_method: 'non_paste',
    text: opts.text,
    text_extra: JSON.stringify(opts.textExtra || []),
  };
  if (opts.replyId) formParams.reply_id = opts.replyId;
  const body = Object.entries(formParams)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

  // 生成 a_bogus 签名（基于 params + body）
  const { aBogus } = signRequest({
    url: '/aweme/v1/web/comment/publish',
    params,
    method: 'POST',
    userAgent: env.userAgent || DEFAULT_UA,
    body,
    cookie: env.cookie,
  });
  if (aBogus) params.a_bogus = aBogus;

  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'user-agent': env.userAgent || DEFAULT_UA,
    cookie: env.cookie,
    origin: 'https://www.douyin.com',
    referer: `https://www.douyin.com/?modal_id=${opts.awemeId}`,
    'x-secsdk-csrf-token': 'DOWNGRADE',
    'bd-ticket-guard-client-data': ticketGuard.clientData,
    'bd-ticket-guard-ree-public-key': ticketGuard.reePublicKey,
    'bd-ticket-guard-version': '2',
    'bd-ticket-guard-web-sign-type': '1',
    'bd-ticket-guard-web-version': '2',
    'x-tt-session-dtrait': ticketGuard.sessionDtrait,
  };

  log.info(`publishComment: awemeId=${opts.awemeId} replyId=${opts.replyId || '(top-level)'} text=${truncate(opts.text, 30)} aBogus=${aBogus ? aBogus.length + 'chars' : 'none'}`);
  try {
    const res = await fetch(url.toString(), { method: 'POST', headers, body });
    if (!res.ok) {
      log.error(`publishComment: HTTP ${res.status}`);
      return { success: false };
    }
    const rawText = await res.text();
    log.debug(`publishComment: response=${rawText.slice(0, 500)}`);
    if (!rawText) {
      // 抓包样本显示成功响应可能为空 body（content-length: 0）
      log.warn('publishComment: 响应为空（可能是重复发布或被风控）');
      return { success: false };
    }
    const j = JSON.parse(rawText) as {
      status_code?: number;
      comment?: { cid?: string };
    };
    if (j.status_code === 0 && j.comment?.cid) {
      log.info(`publishComment: 成功 cid=${j.comment.cid}`);
      return { success: true, commentId: j.comment.cid, raw: j };
    }
    log.warn(`publishComment: 失败 status_code=${j.status_code}`);
    return { success: false, raw: j };
  } catch (e) {
    log.error(`publishComment 异常`, e);
    return { success: false };
  }
}

/** 字符串截断辅助（避免日志过长） */
function truncate(s: string | undefined, max: number): string {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '...' : s;
}
