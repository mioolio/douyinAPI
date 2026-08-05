/**
 * 深度分析 x-secsdk-web-signature 算法
 *
 * 目标：找到与 secsdk 相关的所有数据（32 位 MD5 哈希），反推其生成算法
 *
 * 策略：
 * 1. 收集所有带 x-secsdk-web-signature 的请求样本
 * 2. 提取关键字段：ts, path, query, cookies (含安全 cookie)
 * 3. 尝试各种哈希组合
 * 4. 重点关注 32 位 MD5 算法的输入组合
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_DIR = path.join(__dirname, '..', 'data', 'capture', 'api');

interface SecsdkSample {
  file: string;
  pathname: string;
  fullPath: string;
  query: string;
  timestamp: string;
  secsdk: string;
  aBogus: string;
  aBogusLen: number;
  method: string;
  cookies: Record<string, string>;
  ua: string;
  referer: string;
}

function parseCookie(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function md5(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex');
}

function sm3(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
}

async function main() {
  // 收集样本
  const files = await fs.readdir(API_DIR);
  const samples: SecsdkSample[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(API_DIR, f);
    const text = await fs.readFile(file, 'utf-8');
    let json: any;
    try { json = JSON.parse(text); } catch { continue; }
    const url: string = json.request?.url || '';
    if (!url.includes('x-secsdk-web-signature')) continue;
    const u = new URL(url);
    const secsdk = u.searchParams.get('x-secsdk-web-signature') || '';
    const timestamp = u.searchParams.get('timestamp') || '';
    const aBogus = u.searchParams.get('a_bogus') || '';
    const aBogusDec = decodeURIComponent(aBogus);
    const cookieStr: string = json.request?.headers?.cookie || '';
    const cookies = parseCookie(cookieStr);
    const ua: string = json.request?.headers?.['user-agent'] || '';
    const referer: string = json.request?.headers?.referer || '';
    samples.push({
      file: f,
      pathname: u.pathname,
      fullPath: u.pathname + u.search,
      query: u.search.slice(1),
      timestamp,
      secsdk,
      aBogus: aBogusDec,
      aBogusLen: aBogusDec.length,
      method: json.request?.method || 'GET',
      cookies,
      ua,
      referer,
    });
  }

  console.log(`共 ${samples.length} 个 secsdk 样本\n`);

  // 按 path 分组（同 path 对比不同 secsdk 验证 ts 关系）
  const byPath: Record<string, SecsdkSample[]> = {};
  for (const s of samples) {
    if (!byPath[s.pathname]) byPath[s.pathname] = [];
    byPath[s.pathname].push(s);
  }

  // 显示前 8 个样本
  console.log('=== 前 8 个样本详情 ===');
  for (const s of samples.slice(0, 8)) {
    console.log(`\n[${s.file}] ${s.method} ${s.pathname}`);
    console.log(`  ts=${s.timestamp}`);
    console.log(`  secsdk=${s.secsdk}`);
    console.log(`  a_bogus_len=${s.aBogusLen}`);
    console.log(`  ua=${s.ua.slice(0, 60)}...`);
    console.log(`  cookies: ${Object.keys(s.cookies).slice(0, 10).join(', ')}`);
  }

  // 重点安全 cookie
  console.log('\n=== 所有样本中的安全相关 cookie ===');
  const securityCookies: Record<string, string[]> = {};
  for (const s of samples) {
    for (const k of Object.keys(s.cookies)) {
      if (k.includes('security') || k.includes('__ac_') || k.includes('__security_mc_') || k.includes('bd_ticket') || k.includes('passport') || k.includes('session') || k.includes('uid_tt')) {
        if (!securityCookies[k]) securityCookies[k] = [];
        if (!securityCookies[k].includes(s.cookies[k])) securityCookies[k].push(s.cookies[k]);
      }
    }
  }
  for (const [k, v] of Object.entries(securityCookies)) {
    console.log(`  ${k} (${v.length} 个不同值): ${v.slice(0, 2).map(x => x.slice(0, 60)).join(' | ')}`);
  }

  // 测试各种哈希组合
  console.log('\n=== 哈希组合测试 ===');
  const testSamples = samples.slice(0, 4);

  const tests = [
    { name: 'md5(ts+path)', fn: (s: SecsdkSample) => md5(s.timestamp + s.pathname) },
    { name: 'md5(path+ts)', fn: (s: SecsdkSample) => md5(s.pathname + s.timestamp) },
    { name: 'md5(ts+query)', fn: (s: SecsdkSample) => md5(s.timestamp + s.query) },
    { name: 'md5(query+ts)', fn: (s: SecsdkSample) => md5(s.query + s.timestamp) },
    { name: 'md5(ts+url)', fn: (s: SecsdkSample) => md5(s.timestamp + s.fullPath) },
    { name: 'md5(url+ts)', fn: (s: SecsdkSample) => md5(s.fullPath + s.timestamp) },
    { name: 'md5(ts+path+ua)', fn: (s: SecsdkSample) => md5(s.timestamp + s.pathname + s.ua) },
    { name: 'md5(ts+sessionid+path)', fn: (s: SecsdkSample) => md5(s.timestamp + (s.cookies.sessionid || '') + s.pathname) },
    { name: 'md5(ts+uid_tt+path)', fn: (s: SecsdkSample) => md5(s.timestamp + (s.cookies.uid_tt || '') + s.pathname) },
    { name: 'md5(ts+__security_mc_1_s_sdk_sign_data_key_web_protect+path)', fn: (s: SecsdkSample) => md5(s.timestamp + (s.cookies['__security_mc_1_s_sdk_sign_data_key_web_protect'] || '') + s.pathname) },
    { name: 'md5(ts+bd_ticket_guard_client_data+path)', fn: (s: SecsdkSample) => md5(s.timestamp + (s.cookies.bd_ticket_guard_client_data || '') + s.pathname) },
    { name: 'md5(ts+_bd_ticket_crypt_cookie+path)', fn: (s: SecsdkSample) => md5(s.timestamp + (s.cookies._bd_ticket_crypt_cookie || '') + s.pathname) },
    { name: 'md5(__security_mc_1_s_sdk_sign_data_key_web_protect+ts+path)', fn: (s: SecsdkSample) => md5((s.cookies['__security_mc_1_s_sdk_sign_data_key_web_protect'] || '') + s.timestamp + s.pathname) },
    { name: 'md5(__security_mc_1_s_sdk_cert_key+ts+path)', fn: (s: SecsdkSample) => md5((s.cookies['__security_mc_1_s_sdk_cert_key'] || '') + s.timestamp + s.pathname) },
    { name: 'md5(__security_mc_1_s_sdk_crypt_sdk+ts+path)', fn: (s: SecsdkSample) => md5((s.cookies['__security_mc_1_s_sdk_crypt_sdk'] || '') + s.timestamp + s.pathname) },
    { name: 'md5(__security_mc_1_s_sdk_cert_key+__security_mc_1_s_sdk_crypt_sdk+ts+path)', fn: (s: SecsdkSample) => md5((s.cookies['__security_mc_1_s_sdk_cert_key'] || '') + (s.cookies['__security_mc_1_s_sdk_crypt_sdk'] || '') + s.timestamp + s.pathname) },
    { name: 'md5(ts+path+"tiktok")', fn: (s: SecsdkSample) => md5(s.timestamp + s.pathname + 'tiktok') },
    { name: 'md5(ts+path+"webmssdk")', fn: (s: SecsdkSample) => md5(s.timestamp + s.pathname + 'webmssdk') },
    { name: 'md5(ts+path+"bytedance")', fn: (s: SecsdkSample) => md5(s.timestamp + s.pathname + 'bytedance') },
    { name: 'md5(ts+path+"douyin")', fn: (s: SecsdkSample) => md5(s.timestamp + s.pathname + 'douyin') },
    { name: 'md5(ts+path+fp)', fn: (s: SecsdkSample) => md5(s.timestamp + s.pathname + (s.cookies.s_v_web_id || '')) },
    { name: 'md5(ts+path+webid)', fn: (s: SecsdkSample) => md5(s.timestamp + s.pathname + (new URL(s.fullPath, 'http://x').searchParams.get('webid') || '')) },
    { name: 'sm3(ts+path)', fn: (s: SecsdkSample) => sm3(s.timestamp + s.pathname) },
  ];

  for (const test of tests) {
    let hit = 0;
    for (const s of testSamples) {
      const guess = test.fn(s);
      if (guess === s.secsdk) hit++;
    }
    if (hit > 0) {
      console.log(`  ✓ ${test.name} 命中 ${hit}/${testSamples.length}`);
      for (const s of testSamples) {
        const guess = test.fn(s);
        if (guess === s.secsdk) {
          console.log(`    [${s.file}] 实际=${s.secsdk} guess=${guess}`);
        }
      }
    } else {
      console.log(`  ✗ ${test.name}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
