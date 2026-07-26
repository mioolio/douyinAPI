/**
 * 抖音 IM API 客户端（纯 Node.js fetch + protobuf）
 *
 * 基于 send-flow.json 抓包逆向的协议结构实现。
 *
 * 关键点：
 *   - imapi.douyin.com 接口使用 application/x-protobuf
 *   - Auth: SESSION_AUTH (Cookie, withCredentials=true)
 *   - 多数读接口（list/history）无需 a_bogus/msToken 签名
 *   - 写接口（send）需要 a_bogus + msToken + bd-ticket-guard + identity_security_token
 *
 * Protobuf Request 通用结构（26 个顶层字段，见 send-flow.json body_schema）：
 *   1: cmd (varint)
 *   2: sequence_id (varint, 自增)
 *   3: sdk_version = "0.1.8"
 *   4: token = ""  (SESSION_AUTH 下为空)
 *   5: refer = 3
 *   6: inbox_type (0 私聊 / 1 陌生人)
 *   7: build_number = "0d50935:feat/pc-im-group"
 *   8: body (bytes, 嵌套 message)
 *   9: device_id = "0"
 *   11: device_platform = "douyin_pc"
 *   14: version_code = "360000"
 *   15: headers (map<string,string>, 重复多次)
 *   18: auth_type = 1
 *   21: biz = "douyin_web"
 *   22: access = "web_sdk"
 */
import { createLogger } from '../utils/logger.js';
import { encodeVarintField, encodeStringField, encodeBytesField, encodeMapEntry, parseFields, findField, readVarint, readString, readMessage, WireType, } from '../crypto/protobuf.js';
const log = createLogger('imapi');
/** 抖音 IM API 关键常量（来自 send-flow.json key_constants） */
export const IMAPI_CONSTANTS = {
    apiUrl: 'https://imapi.douyin.com',
    sdkVersion: '0.1.8',
    buildNumber: '0d50935:feat/pc-im-group',
    devicePlatform: 'douyin_pc',
    versionCode: '360000',
    biz: 'douyin_web',
    access: 'web_sdk',
    refer: 3,
    authType: 1,
    aid: '6383',
    fpid: '9',
    appKey: 'e0f82475ab9dbf5717d18b4a9c0d7fd0',
    /** IMCMD 枚举（来自 IM SDK 源码 c58fe...js 逆向） */
    IMCMD: {
        SEND_MESSAGE: 100,
        GET_MESSAGES_BY_CONVERSATION: 301,
        GET_INFO_LIST: 610,
        STRANGER_GET_CONVERSATION_LIST: 1001,
        GET_STRANGER_MESSAGES: 1002,
        GET_USER_CONVERSATION_LIST: 2006,
        GET_READ_INDEX: 2000,
        GET_MIN_INDEX: 2001,
        MARK_CONVERSATION_READ: 2002,
        BATCH_GET_READINDEX: 2038,
        MARK_READ: 1450,
        GET_READ_INDEX_LEGACY: 1452,
        GET_MIN_INDEX_LEGACY: 1453,
        BATCH_GET_READINDEX_LEGACY: 1454,
    },
};
/** 默认浏览器 UA（与抓包样本一致） */
export const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
/**
 * 构造 protobuf Request 二进制
 *
 * 字段顺序按抓包样本还原（部分字段省略：field 4/9/10/12/13/16/17/19/20）。
 */
export function buildRequest(opts) {
    const { cmd, sequenceId, inboxType = 0, body, env, isRetry = false, extraHeaders = {}, } = opts;
    const ua = env.userAgent || DEFAULT_UA;
    // navigator.appVersion：去掉 "Mozilla/" 前缀的完整浏览器版本字符串
    // 抓包样本：browser_version="5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
    const browserVersion = ua.startsWith('Mozilla/') ? ua.slice(8) : ua;
    const deviceId = env.identitySecurityDeviceId || '0';
    // field 15 headers map（按抓包顺序还原，重要：identity_security_* 仅 send_message 需要）
    const headersMap = {
        session_aid: IMAPI_CONSTANTS.aid,
        session_did: '0',
        app_name: 'douyin_pc',
        priority_region: 'cn',
        user_agent: ua,
        cookie_enabled: 'true',
        browser_language: env.browserLanguage || 'zh-CN',
        browser_platform: env.browserPlatform || 'Win32',
        browser_name: 'Mozilla',
        browser_version: browserVersion,
        browser_online: 'true',
        screen_width: String(env.screenWidth || 1400),
        screen_height: String(env.screenHeight || 900),
        referer: '',
        timezone_name: 'Asia/Shanghai',
        deviceId: '0',
        'is-retry': isRetry ? '1' : '0',
        ...extraHeaders,
    };
    // 若提供 identity_security_*，前置加入（仅 send_message 需要）
    if (env.identitySecurityToken) {
        headersMap.identity_security_token = env.identitySecurityToken;
        headersMap.identity_security_aid = env.identitySecurityAid || '';
    }
    if (env.identitySecurityDeviceId && env.identitySecurityDeviceId !== '0') {
        headersMap.identity_security_device_id = env.identitySecurityDeviceId;
    }
    // 按抓包字段顺序拼接
    const parts = [
        encodeVarintField(1, cmd), // cmd
        encodeVarintField(2, sequenceId), // sequence_id
        encodeStringField(3, IMAPI_CONSTANTS.sdkVersion), // sdk_version
        encodeStringField(4, ''), // token (SESSION_AUTH 下为空)
        encodeVarintField(5, IMAPI_CONSTANTS.refer), // refer
        encodeVarintField(6, inboxType), // inbox_type
        encodeStringField(7, IMAPI_CONSTANTS.buildNumber), // build_number
        encodeBytesField(8, body), // body
        encodeStringField(9, '0'), // device_id (固定 "0")
        encodeStringField(11, IMAPI_CONSTANTS.devicePlatform), // device_platform
        encodeStringField(14, IMAPI_CONSTANTS.versionCode), // version_code
    ];
    // field 15 headers map（顺序很重要：send_message 样本中 identity_security_* 排在最前）
    // 仅在提供了 identity_security_token 时才加入 identity_security_*（list/history 不需要）
    const headerOrder = [];
    if (env.identitySecurityToken)
        headerOrder.push('identity_security_token');
    if (env.identitySecurityDeviceId && env.identitySecurityDeviceId !== '0') {
        headerOrder.push('identity_security_device_id');
    }
    if (env.identitySecurityToken)
        headerOrder.push('identity_security_aid');
    headerOrder.push('session_aid', 'session_did', 'app_name', 'priority_region', 'user_agent', 'cookie_enabled', 'browser_language', 'browser_platform', 'browser_name', 'browser_version', 'browser_online', 'screen_width', 'screen_height', 'referer', 'timezone_name', 'deviceId', 'is-retry');
    // 按 headerOrder 顺序写入，去重
    const written = new Set();
    for (const k of headerOrder) {
        if (written.has(k))
            continue;
        written.add(k);
        if (k in headersMap) {
            parts.push(encodeMapEntry(15, k, headersMap[k]));
        }
    }
    parts.push(encodeVarintField(18, IMAPI_CONSTANTS.authType), // auth_type
    encodeStringField(21, IMAPI_CONSTANTS.biz), // biz
    encodeStringField(22, IMAPI_CONSTANTS.access));
    return Buffer.concat(parts);
}
/** 空的 varint 字段，用于 readVarint 的 fallback（避免 undefined） */
const EMPTY_VARINT_FIELD = {
    field: 0,
    wire: WireType.Varint,
    value: 0n,
    offset: 0,
    length: 0,
};
/** 解析 Response protobuf */
export function parseResponse(buf) {
    const fields = parseFields(buf);
    const headersMap = {};
    // field 8 是 map<string,string>（与请求的 field 15 同理，多 entry）
    for (const f of fields) {
        if (f.field !== 8)
            continue;
        const entry = readMessage(f);
        let k = '';
        let v = '';
        for (const e of entry) {
            if (e.field === 1)
                k = readString(e);
            else if (e.field === 2)
                v = readString(e);
        }
        headersMap[k] = v;
    }
    return {
        cmd: readVarint(findField(fields, 1) ?? EMPTY_VARINT_FIELD),
        sequenceId: readVarint(findField(fields, 2) ?? EMPTY_VARINT_FIELD),
        statusCode: readVarint(findField(fields, 3) ?? EMPTY_VARINT_FIELD),
        errorDesc: findField(fields, 4) ? readString(findField(fields, 4)) : '',
        inboxType: readVarint(findField(fields, 5) ?? EMPTY_VARINT_FIELD),
        body: findField(fields, 6) ? findField(fields, 6).value : Buffer.alloc(0),
        logId: findField(fields, 7) ? readString(findField(fields, 7)) : '',
        headers: headersMap,
        serverMessageCreateTime: findField(fields, 10)
            ? readVarint(findField(fields, 10))
            : undefined,
        serverMessageArriveTime: findField(fields, 11)
            ? readVarint(findField(fields, 11))
            : undefined,
        deviceId: findField(fields, 13) ? readVarint(findField(fields, 13)) : undefined,
        authType: findField(fields, 18) ? readVarint(findField(fields, 18)) : undefined,
        rawFields: fields,
    };
}
/** 发送 imapi HTTP 请求并解析 Response */
export async function sendImapi(opts) {
    const { path, body, cookie, userAgent = DEFAULT_UA, query, extraHeaders = {}, timeoutMs = 10_000, } = opts;
    // 构造 URL
    const url = new URL(IMAPI_CONSTANTS.apiUrl + path);
    if (query) {
        for (const [k, v] of Object.entries(query)) {
            url.searchParams.set(k, v);
        }
    }
    // 构造 headers（按抓包样本还原，关键 headers 不能省略）
    const headers = {
        accept: 'application/x-protobuf',
        'content-type': 'application/x-protobuf',
        'user-agent': userAgent,
        cookie,
        origin: 'https://www.douyin.com',
        referer: 'https://www.douyin.com/',
        'accept-language': 'zh-CN,zh;q=0.9',
        'sec-ch-ua': '"Chromium";v="149", "Not)A;Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-site',
        priority: 'u=1, i',
        ...extraHeaders,
    };
    log.debug(`POST ${url.toString()} (body=${body.length}B)`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url.toString(), {
            method: 'POST',
            headers,
            body: new Uint8Array(body),
            signal: controller.signal,
        });
        const respBuf = Buffer.from(await res.arrayBuffer());
        if (!res.ok) {
            log.error(`HTTP ${res.status}: ${respBuf.toString('utf-8').slice(0, 500)}`);
            throw new Error(`HTTP ${res.status}`);
        }
        const parsed = parseResponse(respBuf);
        log.debug(`resp: cmd=${parsed.cmd} seq=${parsed.sequenceId} status=${parsed.statusCode} desc=${parsed.errorDesc} body=${parsed.body.length}B logId=${parsed.logId}`);
        return parsed;
    }
    finally {
        clearTimeout(timer);
    }
}
