/**
 * 个人主页 / 互动消息 / 资料修改命令（纯 API 实现）
 *
 * 抓包+实测确认：
 *   - /aweme/v1/web/user/profile/self/    仅需 Cookie，无需 a_bogus
 *   - /aweme/v1/web/notice/?notice_group=  仅需 Cookie，无需 a_bogus
 *   - /aweme/v1/web/commit/user/           本模块会带 a_bogus（abogus.ts 纯算）
 *
 * 不再启动浏览器进行页面导航，全部以纯 API 方式请求。
 */

import { createLogger } from '../utils/logger.js';
import { generateABogus } from '../crypto/abogus.js';
import { sign as signRequest, extractMsToken, extractVerifyFp } from '../crypto/signature.js';

const log = createLogger('profile');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** profile/self / commit/user 共用的「设备/浏览器」query 参数 */
const WEB_PARAMS: Record<string, string> = {
  device_platform: 'webapp',
  aid: '6383',
  channel: 'channel_pc_web',
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
  round_trip_time: '150',
};

/* ----------------------------- 个人主页信息 ----------------------------- */

export interface SelfProfile {
  uid: string;
  secUid: string;
  nickname: string;
  /** 抖音号 */
  uniqueId?: string;
  /** 简介 */
  signature?: string;
  avatarUrl?: string;
  avatarUri?: string;
  /** 关注数 */
  followingCount?: number;
  /** 粉丝数 */
  followerCount?: number;
  /** 获赞数 */
  totalFavorited?: number;
  /** 作品数 */
  awemeCount?: number;
  /** 国家 / 地区 */
  country?: string;
  bindPhone?: string;
}

/**
 * 获取当前账号主页信息
 *
 * 纯 API 调用：GET /aweme/v1/web/user/profile/self/
 *
 * 抓包+实测确认：此接口仅需 Cookie 鉴权，无需 a_bogus / msToken 等签名
 * （profile/self 接口对未签名请求会返回完整数据，与 notice 接口一致）。
 *
 * @param env 请求环境（只需 cookie）
 */
export async function getSelfProfile(
  env: import('../api/imapi.js').RequestEnv,
): Promise<SelfProfile> {
  const url = new URL('https://www.douyin.com/aweme/v1/web/user/profile/self/');
  for (const [k, v] of Object.entries(WEB_PARAMS)) {
    url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'user-agent': env.userAgent || DEFAULT_UA,
    cookie: env.cookie,
    origin: 'https://www.douyin.com',
    referer: 'https://www.douyin.com/user/self?from_tab_name=main&showTab=post',
  };

  log.info(`getSelfProfile: GET /aweme/v1/web/user/profile/self/`);
  const res = await fetch(url.toString(), { method: 'GET', headers });
  if (!res.ok) {
    throw new Error(`profile/self HTTP ${res.status}`);
  }
  const text = await res.text();
  if (text.length === 0) {
    throw new Error('profile/self 返回空 body（可能需要 a_bogus 签名）');
  }
  const j = JSON.parse(text) as {
    status_code?: number;
    user?: Record<string, unknown>;
  };
  if (j.status_code !== 0 || !j.user) {
    throw new Error(`profile/self status_code=${j.status_code}`);
  }
  const u = j.user;
  const pickStr = (k: string): string | undefined => {
    const v = u[k];
    return typeof v === 'string' ? v : v != null ? String(v) : undefined;
  };
  const pickNum = (k: string): number | undefined => {
    const v = u[k];
    return typeof v === 'number' ? v : typeof v === 'string' ? Number(v) || undefined : undefined;
  };
  const avatarObj = (u.avatar_larger || u.avatar_medium || u.avatar_thumb) as
    | { url_list?: string[]; uri?: string }
    | undefined;
  return {
    uid: pickStr('uid') || '',
    secUid: pickStr('sec_uid') || '',
    nickname: pickStr('nickname') || '',
    uniqueId: pickStr('unique_id'),
    signature: pickStr('signature'),
    avatarUrl: avatarObj?.url_list?.[0],
    avatarUri: avatarObj?.uri,
    followingCount: pickNum('following_count'),
    followerCount: pickNum('follower_count'),
    totalFavorited: pickNum('total_favorited'),
    awemeCount: pickNum('aweme_count'),
    country: pickStr('country'),
    bindPhone: pickStr('bind_phone'),
  };
}

/* ----------------------------- 互动消息列表 ----------------------------- */

export interface NoticeItem {
  /** 通知 ID（优先 nid_str，回退 nid） */
  nid: string;
  /** 通知类型（8=新粉丝, 31=评论, 33=@提及, 41=点赞, 45=回复, ...） */
  type: number;
  /** 创建时间戳（秒） */
  createTime: number;
  /** 是否已读 */
  hasRead: boolean;
  /** 关联视频 aweme_id */
  awemeId?: string;
  /** 关联视频描述 */
  awemeDesc?: string;
  /** 作者昵称 */
  authorNickname?: string;
  /** 评论内容（评论通知时） */
  commentText?: string;
  /** 关联评论 ID（type=45 从 at.schema_url 解析；type=41 从 digg.real_cid 提取） */
  commentId?: string;
  /** 触发用户昵称（点赞用户等） */
  fromNickname?: string;
  /** 触发用户 uid */
  fromUid?: string;
  /** 触发用户 sec_uid */
  fromSecUid?: string;
  /** 合并数量（同视频多次点赞合并显示） */
  mergeCount?: number;
  /** 点赞子类型 */
  diggType?: number;
  /** 跳转链接 */
  schemaUrl?: string;
  /** 跳转文案（如「查看详情」） */
  schemaText?: string;
  /** 标签文案（如「赞了你的视频/评论」） */
  labelText?: string;
}

/**
 * 拉取互动消息列表（点赞 / 评论 / 新粉丝等）
 *
 * 纯 API 调用：GET /aweme/v1/web/notice/?notice_group=960
 *
 * 抓包+实测确认：此接口仅需 Cookie 鉴权，无需 a_bogus / msToken / verifyFp 等签名。
 * notice_group=960 即「互动消息」分组。
 *
 * @param env 请求环境（只需 cookie）
 */
export async function getNotices(
  env: import('../api/imapi.js').RequestEnv,
  opts: { count?: number; minTime?: number; maxTime?: number } = {},
): Promise<{ items: NoticeItem[]; hasMore: boolean; minTime: number; maxTime: number }> {
  const count = opts.count ?? 20;
  const minTime = opts.minTime ?? 0;
  const maxTime = opts.maxTime ?? 0;
  const url = new URL('https://www.douyin.com/aweme/v1/web/notice/');
  const params: Record<string, string> = {
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    is_new_notice: '1',
    is_mark_read: '1',
    notice_group: '960',
    count: String(count),
    min_time: String(minTime),
    max_time: String(maxTime),
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
    round_trip_time: '150',
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
    referer: 'https://www.douyin.com/user/self?from_tab_name=main&showTab=post',
  };

  log.info(`getNotices: count=${count} min=${minTime} max=${maxTime}`);
  const res = await fetch(url.toString(), { method: 'GET', headers });
  if (!res.ok) {
    throw new Error(`notice HTTP ${res.status}`);
  }
  const j = (await res.json()) as {
    status_code?: number;
    has_more?: boolean;
    max_time?: number;
    min_time?: number;
    notice_list_v2?: Array<Record<string, unknown>>;
  };
  if (j.status_code !== 0) {
    throw new Error(`notice status_code=${j.status_code}`);
  }
  const items: NoticeItem[] = [];
  for (const n of j.notice_list_v2 ?? []) {
    items.push(parseNoticeItem(n));
  }
  return {
    items,
    hasMore: Boolean(j.has_more),
    minTime: Number(j.min_time ?? 0),
    maxTime: Number(j.max_time ?? 0),
  };
}

/**
 * 解析单条通知为 NoticeItem
 *
 * 抓包确认不同 type 的字段位置不同：
 *   type=41 (点赞)  → n.digg.{aweme, from_user[], comment?, merge_count, digg_type, cid, real_cid}
 *   type=31 (评论)  → n.comment.comment.{text, user, aweme_id}
 *   type=33 (新粉丝) → n.follow.from_user.{uid, nickname, sec_uid}
 *   type=45 (@提及) → n.at.{user_info, aweme, content, reply_comment, schema_url}
 */
function parseNoticeItem(n: Record<string, unknown>): NoticeItem {
  const digg = n.digg as
    | {
        aweme?: { aweme_id?: string; desc?: string; author?: { nickname?: string } };
        // 注意：digg.from_user 是数组，general_notice.from_user 是对象
        from_user?: Array<{ uid?: string; nickname?: string; sec_uid?: string }>;
        comment?: { text?: string };
        merge_count?: number;
        digg_type?: number;
        cid?: number | string;
        real_cid?: string;
      }
    | undefined;
  // type=31 评论：n.comment.comment 才是评论本体
  const commentWrap = n.comment as
    | { comment?: { text?: string; aweme_id?: string; user?: { uid?: string; nickname?: string; sec_uid?: string } } }
    | undefined;
  const comment = commentWrap?.comment;
  // type=33 新粉丝：n.follow.from_user 是单个对象
  const followFromUser = (n.follow as { from_user?: { uid?: string; nickname?: string; sec_uid?: string } } | undefined)
    ?.from_user;
  // type=45 @提及：n.at.{user_info, aweme, content, reply_comment, schema_url}
  const at = n.at as
    | {
        user_info?: { uid?: string; nickname?: string; sec_uid?: string };
        aweme?: { aweme_id?: string; desc?: string; author?: { nickname?: string } };
        content?: string;
        reply_comment?: { text?: string };
        schema_url?: string;
      }
    | undefined;
  // general_notice 子对象：跳转链接 / 标签文案
  const general = n.general_notice as
    | {
        schema_url?: string;
        schema_text?: string;
        label_text?: string;
        aweme?: { aweme_id?: string; desc?: string; author?: { nickname?: string } };
      }
    | undefined;

  // 顶层 aweme_id（type=31/41/45 都有；type=33 是 0）
  const topAwemeId = typeof n.aweme_id === 'string' || typeof n.aweme_id === 'number' ? String(n.aweme_id) : undefined;
  const aweme = digg?.aweme || at?.aweme || general?.aweme;
  const awemeId = aweme?.aweme_id || comment?.aweme_id || topAwemeId;
  const awemeDesc = aweme?.desc;

  // fromUser 来源按 type 区分
  const fromUserArr = digg?.from_user;
  const fromUser = fromUserArr?.[0] || followFromUser || at?.user_info;
  let commentText: string | undefined;
  if (comment?.text) {
    commentText = comment.text;
  } else if (at?.reply_comment?.text) {
    // type=45 @提及：reply_comment 是被回复的评论内容
    commentText = at.reply_comment.text;
  } else if (digg?.comment?.text) {
    // 点赞带评论场景
    commentText = digg.comment.text;
  }
  // type=45 的 at.content（如 "@Mak"）作为补充信息
  const atContent = at?.content;

  // 提取 commentId：
  //   type=45 @提及 → 从 at.schema_url 解析 cid 查询参数（格式：aweme://aweme/detail/{aweme_id}?cid={cid}）
  //   type=41 点赞评论 → digg.real_cid 或 digg.cid
  let commentId: string | undefined;
  const atSchemaUrl = at?.schema_url || general?.schema_url;
  if (atSchemaUrl) {
    try {
      const cidParam = new URL(atSchemaUrl).searchParams.get('cid');
      if (cidParam) commentId = cidParam;
    } catch {
      // schema_url 可能是 aweme:// 协议，URL 解析失败时用正则兜底
      const m = atSchemaUrl.match(/[?&]cid=(\d+)/);
      if (m) commentId = m[1];
    }
  }
  if (!commentId) {
    commentId = digg?.real_cid || (digg?.cid ? String(digg.cid) : undefined);
  }

  return {
    // 优先 nid_str（前端使用此字段），回退到 nid
    nid: String(n.nid_str ?? n.nid ?? ''),
    type: Number(n.type ?? 0),
    createTime: Number(n.create_time ?? 0),
    hasRead: Boolean(n.has_read),
    awemeId: awemeId && awemeId !== '0' ? awemeId : undefined,
    awemeDesc,
    authorNickname: aweme?.author?.nickname,
    commentText,
    commentId,
    // type=45 @提及用 at.content 作为 fromNickname（如 "@Mak"），否则取用户昵称
    fromNickname: fromUser?.nickname || atContent,
    fromUid: fromUser?.uid ? String(fromUser.uid) : undefined,
    fromSecUid: fromUser?.sec_uid,
    mergeCount: digg?.merge_count,
    diggType: digg?.digg_type,
    schemaUrl: general?.schema_url,
    schemaText: general?.schema_text,
    labelText: general?.label_text,
  };
}

/**
 * 查询单条通知详情
 *
 * 纯 API 调用：GET /aweme/v1/web/notice/detail/?id_list=[{"notice_id_str":"<nid>","type":0}]
 *
 * 抓包确认：此接口需要 Cookie + a_bogus + msToken + verifyFp + fp 签名。
 * 用于获取通知完整详情，特别是 type=45 艾特通知的 schema_url（含 aweme_id 和 cid 跳转参数）。
 *
 * @param env 请求环境
 * @param nid 通知 ID（nid_str）
 */
export async function getNoticeDetail(
  env: import('../api/imapi.js').RequestEnv,
  nid: string,
): Promise<NoticeItem | null> {
  const url = new URL('https://www.douyin.com/aweme/v1/web/notice/detail/');
  const idList = JSON.stringify([{ notice_id_str: nid, type: 0 }]);
  const params: Record<string, string> = {
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    id_list: idList,
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
  };

  // 生成 a_bogus 签名
  const { aBogus } = signRequest({
    url: '/aweme/v1/web/notice/detail/',
    params,
    method: 'GET',
    userAgent: env.userAgent || DEFAULT_UA,
    body: '',
    cookie: env.cookie,
  });
  if (aBogus) params.a_bogus = aBogus;
  const msToken = extractMsToken(env.cookie);
  const verifyFp = extractVerifyFp(env.cookie);
  if (msToken) params.msToken = msToken;
  if (verifyFp) {
    params.verifyFp = verifyFp;
    params.fp = verifyFp;
  }

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

  log.info(`getNoticeDetail: nid=${nid} aBogus=${aBogus ? aBogus.length + 'chars' : 'none'}`);
  const res = await fetch(url.toString(), { method: 'GET', headers });
  if (!res.ok) {
    throw new Error(`notice/detail HTTP ${res.status}`);
  }
  const j = (await res.json()) as {
    status_code?: number;
    notice_list_v2?: Array<Record<string, unknown>> | null;
  };
  if (j.status_code !== 0) {
    throw new Error(`notice/detail status_code=${j.status_code}`);
  }
  if (!j.notice_list_v2 || j.notice_list_v2.length === 0) {
    return null;
  }
  return parseNoticeItem(j.notice_list_v2[0]);
}

/* ----------------------------- 资料修改 ----------------------------- */

export interface EditProfileInput {
  /** 昵称（不传则不修改） */
  nickname?: string;
  /** 简介（不传则不修改） */
  signature?: string;
  /** 头像本地文件路径（不传则不修改） */
  avatarPath?: string;
}

export interface EditProfileResult {
  success: boolean;
  message: string;
  /** 修改后的资料（如成功） */
  profile?: SelfProfile;
}

/**
 * 修改个人资料（昵称 / 简介 / 头像）
 *
 * 完整流程（纯 API）：
 *   1. 头像（如指定）：纯 API 上传到 ImageX（imagex.bytedanceapi.com）
 *      - getUploadConfig → applyImageUpload → uploadAvatarToTos(PUT) → commitImageUpload
 *      - 获得 avatar_uri（即 StoreUri，与抓包确认的格式一致）
 *   2. commit/user：纯 fetch + a_bogus 签名
 *      - body: avatar_uri=... & nickname=... & signature=...
 *      - a_bogus 由 abogus.ts 纯算生成（参考 haloowhite.com 逆向文章）
 *
 * @param input 修改内容
 * @param env 请求环境（cookie + UA）
 * @param userId 当前用户 uid（用于 x-storage-u 头）
 * @param ticketGuard bd-ticket-guard 三头（写接口必需，从 ticket-guard --auto 获取）
 */
export async function editProfile(
  input: EditProfileInput,
  env: import('../api/imapi.js').RequestEnv,
  userId: string,
  ticketGuard?: import('../api/webapi.js').TicketGuardHeaders,
): Promise<EditProfileResult> {
  if (!input.nickname && !input.signature && !input.avatarPath) {
    return { success: false, message: '未指定任何修改项' };
  }

  // 1. 头像：纯 API 上传到 ImageX，获取 avatar_uri
  let avatarUri: string | null = null;
  if (input.avatarPath) {
    const { uploadAvatar } = await import('../api/tos.js');
    const fs = await import('node:fs/promises');
    let imageBytes: Buffer;
    try {
      imageBytes = await fs.readFile(input.avatarPath);
    } catch (e) {
      return { success: false, message: `读取头像文件失败: ${e instanceof Error ? e.message : String(e)}` };
    }
    log.info(`editProfile: 上传头像 ${input.avatarPath} (${imageBytes.length}B)`);
    avatarUri = await uploadAvatar(env, imageBytes, userId);
    if (!avatarUri) {
      return { success: false, message: '头像上传失败（ImageX 流程）' };
    }
    log.info(`editProfile: 头像上传成功 avatar_uri=${avatarUri}`);
  }

  // 2. commit/user：纯 API + a_bogus 签名
  const formBody = new URLSearchParams();
  if (avatarUri) formBody.set('avatar_uri', avatarUri);
  if (input.nickname) formBody.set('nickname', input.nickname);
  if (input.signature) formBody.set('signature', input.signature);
  const bodyStr = formBody.toString();

  // 构造 params（含 msToken / verifyFp，但不含 a_bogus —— a_bogus 基于这些 params 计算）
  const params: Record<string, string> = { ...WEB_PARAMS };
  const msToken = extractMsToken(env.cookie);
  const verifyFp = extractVerifyFp(env.cookie);
  if (msToken) params.msToken = msToken;
  if (verifyFp) {
    params.verifyFp = verifyFp;
    params.fp = verifyFp;
  }

  // 生成 a_bogus（params 不含 a_bogus 本身，body 为表单字符串）
  const aBogus = generateABogus({
    url: '/aweme/v1/web/commit/user/',
    params: { ...params },
    method: 'POST',
    userAgent: env.userAgent || DEFAULT_UA,
    body: bodyStr,
  });
  params.a_bogus = aBogus;
  log.info(`editProfile: 生成 a_bogus (len=${aBogus.length})`);
  log.info(`editProfile: msToken=${msToken ? '有' : '无'} verifyFp=${verifyFp ? '有' : '无'}`);

  const url = new URL('https://www.douyin.com/aweme/v1/web/commit/user/');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'user-agent': env.userAgent || DEFAULT_UA,
    cookie: env.cookie,
    origin: 'https://www.douyin.com',
    referer: 'https://www.douyin.com/user/self?from_tab_name=main&showTab=post',
    'x-secsdk-csrf-token': 'DOWNGRADE',
    'x-tt-session-dtrait': ticketGuard?.sessionDtrait || '',
  };
  if (ticketGuard?.clientData) {
    headers['bd-ticket-guard-client-data'] = ticketGuard.clientData;
    headers['bd-ticket-guard-ree-public-key'] = ticketGuard.reePublicKey || '';
    headers['bd-ticket-guard-version'] = '2';
    headers['bd-ticket-guard-web-version'] = '2';
    headers['bd-ticket-guard-web-sign-type'] = '1';
  }

  // 打印完整 URL（检查是否有空格等异常字符）
  const fullUrl = url.toString();
  log.info(`editProfile: POST ${fullUrl}`);
  log.info(`editProfile: body=${bodyStr}`);
  if (fullUrl.includes(' ')) {
    log.warn(`editProfile: ⚠️ URL 中检测到空格！`);
  }
  const res = await fetch(fullUrl, { method: 'POST', headers, body: bodyStr });
  if (!res.ok) {
    return { success: false, message: `commit/user HTTP ${res.status}` };
  }
  const text = await res.text();
  if (text.length === 0) {
    return {
      success: false,
      message: 'commit/user 返回空 body（可能 a_bogus 签名无效或 cookie 失效）',
    };
  }
  log.info(`editProfile: 响应 body=${text.slice(0, 500)}`);
  const j = JSON.parse(text) as {
    status_code?: number;
    status_msg?: string;
    toast_back_info?: { toast_msg?: string };
    user?: Record<string, unknown>;
  };
  if (j.status_code !== 0) {
    const toast = j.toast_back_info?.toast_msg || '';
    const msg = j.status_msg || '';
    return {
      success: false,
      message: `commit/user status_code=${j.status_code}${toast ? ` (${toast})` : ''}${msg ? ` msg=${msg}` : ''}`,
    };
  }

  // 3. 解析返回的 user 对象（commit/user 响应直接包含最新 user 信息）
  if (j.user) {
    const u = j.user;
    const avatarObj = (u.avatar_larger || u.avatar_medium || u.avatar_thumb) as
      | { url_list?: string[]; uri?: string }
      | undefined;
    const result: SelfProfile = {
      uid: String(u.uid ?? ''),
      secUid: String(u.sec_uid ?? ''),
      nickname: String(u.nickname ?? ''),
      uniqueId: typeof u.unique_id === 'string' ? u.unique_id : undefined,
      signature: typeof u.signature === 'string' ? u.signature : undefined,
      avatarUrl: avatarObj?.url_list?.[0],
      avatarUri: avatarObj?.uri,
    };
    return { success: true, message: '修改成功', profile: result };
  }
  return { success: true, message: '修改成功' };
}
