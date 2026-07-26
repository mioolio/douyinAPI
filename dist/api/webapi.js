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
import { DEFAULT_UA } from './imapi.js';
const log = createLogger('webapi');
const WEB_API_BASE = 'https://www.douyin.com/aweme/v1/web/im';
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
export async function getReadOnceImage(env, msgId, conversationShortId) {
    const url = new URL(`${WEB_API_BASE}/read_once/detail`);
    const params = {
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
    const headers = {
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
        const j = (await res.json());
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
        const info = JSON.parse(j.show_once_info);
        const ru = info.resource_url;
        if (!ru || !ru.large_url_list?.length) {
            log.warn(`getReadOnceImage: show_once_info 内无 large_url_list`);
            return null;
        }
        const result = {
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
        log.info(`getReadOnceImage: 成功 oid=${result.oid} size=${result.dataSize || '?'}B`);
        return result;
    }
    catch (e) {
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
export async function buildImageUrl(env, oid, format = 'tplv-x-get:large.image') {
    const url = new URL('https://www.douyin.com/aweme/v1/web/privacy/batch_build_image/');
    const params = {
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
    const headers = {
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
        const j = (await res.json());
        const urls = j.data?.pack_results?.[0]?.UrlList;
        if (!urls || urls.length === 0) {
            log.warn(`buildImageUrl: 无 UrlList (status_code=${j.status_code})`);
            return [];
        }
        return urls;
    }
    catch (e) {
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
export async function getUserInfoBatch(env, secUids) {
    // 去重 + 过滤空值
    const unique = Array.from(new Set(secUids.filter((s) => s && s.length > 0)));
    if (unique.length === 0)
        return [];
    const results = [];
    const batchSize = 50;
    for (let i = 0; i < unique.length; i += batchSize) {
        const batch = unique.slice(i, i + batchSize);
        const batchResults = await fetchUserInfoBatch(env, batch);
        results.push(...batchResults);
    }
    return results;
}
/** 构造 sec_uid -> WebUserInfo 的映射，便于查找 */
export async function getUserInfoMap(env, secUids) {
    const list = await getUserInfoBatch(env, secUids);
    const map = new Map();
    for (const u of list)
        map.set(u.secUid, u);
    return map;
}
async function fetchUserInfoBatch(env, secUids) {
    const url = new URL(`${WEB_API_BASE}/user/info/`);
    // 基础 query 参数（与抓包样本一致，不含签名）
    const params = {
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
    const headers = {
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
        const j = (await res.json());
        if (j.status_code !== 0 || !Array.isArray(j.data)) {
            log.warn(`getUserInfoBatch: status_code=${j.status_code}`);
            return [];
        }
        const results = [];
        for (const u of j.data) {
            if (!u.sec_uid || !u.nickname)
                continue;
            results.push({
                uid: u.uid || '',
                secUid: u.sec_uid,
                nickname: u.nickname,
                remarkName: u.remark_name || undefined,
                signature: u.signature || undefined,
                avatarThumb: u.avatar_thumb?.url_list?.[0],
            });
        }
        log.info(`getUserInfoBatch: 成功获取 ${results.length}/${secUids.length} 个用户信息`);
        return results;
    }
    catch (e) {
        log.error(`getUserInfoBatch 异常`, e);
        return [];
    }
}
