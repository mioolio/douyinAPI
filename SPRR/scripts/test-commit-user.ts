/**
 * commit/user 接口签名测试（cookie 已重登，可端到端验证）
 *
 * 用「同值」提交（拿当前 nickname/signature 原样提交），不会真正修改资料。
 */
import { generateABogus } from '../src/crypto/abogus.js';
import { loadFromStorageState } from '../src/auth/session.js';
import { envFromSession } from '../src/api/operations.js';
import { resolveStorageState } from '../src/auth/accounts.js';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('test-commit-user');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

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

async function getProfileSelf(env: { cookie: string; userAgent?: string }) {
  const url = new URL('https://www.douyin.com/aweme/v1/web/user/profile/self/');
  for (const [k, v] of Object.entries(WEB_PARAMS)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      accept: 'application/json, text/plain, */*',
      'user-agent': env.userAgent || DEFAULT_UA,
      cookie: env.cookie,
      origin: 'https://www.douyin.com',
      referer: 'https://www.douyin.com/user/self?from_tab_name=main&showTab=post',
    },
  });
  return (await res.json()) as { status_code?: number; user?: { nickname?: string; signature?: string } };
}

async function callCommitUser(env: { cookie: string; userAgent?: string }, body: string, withABogus: boolean) {
  const params = { ...WEB_PARAMS };
  if (withABogus) {
    const aBogus = generateABogus({
      url: '/aweme/v1/web/commit/user/',
      params: { ...WEB_PARAMS },
      method: 'POST',
      userAgent: env.userAgent || DEFAULT_UA,
      body,
    });
    params.a_bogus = aBogus;
    log.info(`生成 a_bogus (len=${aBogus.length}): ${aBogus.slice(0, 80)}...`);
  } else {
    log.info('不附加 a_bogus（对照组）');
  }

  const url = new URL('https://www.douyin.com/aweme/v1/web/commit/user/');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      'user-agent': env.userAgent || DEFAULT_UA,
      cookie: env.cookie,
      origin: 'https://www.douyin.com',
      referer: 'https://www.douyin.com/user/self?from_tab_name=main&showTab=post',
      'x-secsdk-csrf-token': 'DOWNGRADE',
    },
    body,
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

async function main() {
  const { path: statePath } = await resolveStorageState(undefined, undefined);
  log.info(`使用 storageState: ${statePath}`);
  const session = await loadFromStorageState(statePath);
  const env = envFromSession(session);

  // 1. 获取当前 profile
  log.info('\n=== 步骤 1: 获取当前 profile ===');
  const profile = await getProfileSelf(env);
  if (profile.status_code !== 0 || !profile.user) {
    log.error(`profile/self 失败: status_code=${profile.status_code}`);
    process.exit(1);
  }
  const curNickname = profile.user.nickname || '';
  const curSignature = profile.user.signature || '';
  log.info(`当前 nickname="${curNickname}" signature="${curSignature}"`);

  const formBody = new URLSearchParams();
  formBody.set('nickname', curNickname);
  formBody.set('signature', curSignature);
  const bodyStr = formBody.toString();
  log.info(`提交 body: ${bodyStr}`);

  // 2. 不带 a_bogus
  log.info('\n=== 测试 1: 不带 a_bogus ===');
  const r1 = await callCommitUser(env, bodyStr, false);
  log.info(`HTTP ${r1.status}, body 长度 ${r1.body.length} 字节`);
  log.info(`body: ${r1.body.slice(0, 300) || '(空)'}`);

  // 3. 带 a_bogus
  log.info('\n=== 测试 2: 带 a_bogus ===');
  const r2 = await callCommitUser(env, bodyStr, true);
  log.info(`HTTP ${r2.status}, body 长度 ${r2.body.length} 字节`);
  log.info(`body: ${r2.body.slice(0, 300) || '(空)'}`);
}

main().catch((e) => {
  log.error('测试失败', e);
  process.exit(1);
});
