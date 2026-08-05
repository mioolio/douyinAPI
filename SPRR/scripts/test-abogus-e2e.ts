/**
 * a_bogus 端到端测试
 *
 * 验证流程：
 *   1. 加载真实 cookie
 *   2. 用 abogus.ts 生成 a_bogus
 *   3. 调用 /aweme/v1/web/user/profile/self/ 接口
 *   4. 对比有/无 a_bogus 的响应
 *
 * 期望：
 *   - 无 a_bogus：HTTP 200 但 body 为空（或 status_code != 0）
 *   - 有 a_bogus：HTTP 200 + status_code=0 + user 对象
 */
import { generateABogus } from '../src/crypto/abogus.js';
import { loadFromStorageState } from '../src/auth/session.js';
import { envFromSession } from '../src/api/operations.js';
import { resolveStorageState } from '../src/auth/accounts.js';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('test-abogus');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// profile/self 接口的固定参数
const PROFILE_PARAMS: Record<string, string> = {
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
  round_trip_time: '0',
};

async function callProfileSelf(env: { cookie: string; userAgent?: string }, withABogus: boolean) {
  const params = { ...PROFILE_PARAMS };
  if (withABogus) {
    const aBogus = generateABogus({
      url: '/aweme/v1/web/user/profile/self/',
      params: { ...PROFILE_PARAMS },
      method: 'GET',
      userAgent: env.userAgent || DEFAULT_UA,
    });
    params.a_bogus = aBogus;
    log.info(`生成 a_bogus (len=${aBogus.length}): ${aBogus.slice(0, 80)}...`);
  } else {
    log.info('不附加 a_bogus（对照组）');
  }

  const url = new URL('https://www.douyin.com/aweme/v1/web/user/profile/self/');
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

  const res = await fetch(url.toString(), { method: 'GET', headers });
  const text = await res.text();
  return { status: res.status, body: text };
}

async function main() {
  // 加载 session
  const { path: statePath } = await resolveStorageState(undefined, undefined);
  log.info(`使用 storageState: ${statePath}`);
  const session = await loadFromStorageState(statePath);
  const env = envFromSession(session);

  // 1. 对照组：无 a_bogus
  log.info('\n=== 测试 1: 无 a_bogus（对照组） ===');
  const r1 = await callProfileSelf(env, false);
  log.info(`HTTP ${r1.status}, body 长度 ${r1.body.length} 字节`);
  log.info(`body 前 200 字符: ${r1.body.slice(0, 200) || '(空)'}`);

  // 2. 实验组：带 a_bogus
  log.info('\n=== 测试 2: 带 a_bogus ===');
  const r2 = await callProfileSelf(env, true);
  log.info(`HTTP ${r2.status}, body 长度 ${r2.body.length} 字节`);
  log.info(`body 前 200 字符: ${r2.body.slice(0, 200) || '(空)'}`);

  // 3. 解析结果
  log.info('\n=== 结论 ===');
  if (r2.body.length === 0) {
    log.error('带 a_bogus 仍返回空 body - a_bogus 签名无效');
    process.exit(1);
  }
  let j2: { status_code?: number; user?: { nickname?: string; uid?: string } } = {};
  try {
    j2 = JSON.parse(r2.body);
  } catch {
    log.error(`带 a_bogus 返回非 JSON: ${r2.body.slice(0, 100)}`);
    process.exit(1);
  }
  if (j2.status_code === 0 && j2.user) {
    log.info(`✓ a_bogus 验证成功！`);
    log.info(`  nickname: ${j2.user.nickname}`);
    log.info(`  uid: ${j2.user.uid}`);
    process.exit(0);
  } else {
    log.error(`✗ a_bogus 签名被拒绝: status_code=${j2.status_code}`);
    process.exit(1);
  }
}

main().catch((e) => {
  log.error('测试失败', e);
  process.exit(1);
});
