/**
 * 提取 4 个 x-secsdk-web-signature 样本做算法分析
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FILES = [
  '0212_GET_4a51e4702552.json',
  '0293_GET_ca6d961b5af9.json',
  '0476_GET_b5c423097431.json',
  '0531_GET_872729517753.json',
];

const API_DIR = path.join(__dirname, '..', 'data', 'capture', 'api');

interface Sample {
  file: string;
  pathname: string;
  timestamp: string;
  secsdk: string;
  aBogus: string;
  aBogusLen: number;
  params: Record<string, string>;
  cookieKeys: string[];
  cookieSnippet: string;
}

async function main() {
  const samples: Sample[] = [];
  for (const f of FILES) {
    const file = path.join(API_DIR, f);
    const text = await fs.readFile(file, 'utf-8');
    const json = JSON.parse(text);
    const url: string = json.request.url;
    const u = new URL(url);
    const secsdk = u.searchParams.get('x-secsdk-web-signature') || '';
    const timestamp = u.searchParams.get('timestamp') || '';
    const aBogus = u.searchParams.get('a_bogus') || '';
    const aBogusDecoded = decodeURIComponent(aBogus);
    const params: Record<string, string> = {};
    for (const [k, v] of u.searchParams.entries()) params[k] = v;
    const cookieStr: string = json.request.headers?.cookie || '';
    const cookies = cookieStr.split(';').map((c: string) => c.trim().split('=')[0]);
    samples.push({
      file: f,
      pathname: u.pathname,
      timestamp,
      secsdk,
      aBogus: aBogusDecoded,
      aBogusLen: aBogusDecoded.length,
      params,
      cookieKeys: cookies,
      cookieSnippet: cookieStr.substring(0, 300),
    });
  }

  console.log(`=== 共 ${samples.length} 个样本 ===\n`);
  for (const s of samples) {
    console.log(`文件: ${s.file}`);
    console.log(`Path: ${s.pathname}`);
    console.log(`timestamp: ${s.timestamp}`);
    console.log(`x-secsdk-web-signature: ${s.secsdk}`);
    console.log(`a_bogus (len=${s.aBogusLen}): ${s.aBogus}`);
    console.log(`a_bogus 前 60 字符: ${s.aBogus.substring(0, 60)}`);
    console.log(`a_bogus 后 60 字符: ${s.aBogus.substring(s.aBogus.length - 60)}`);
    console.log(`参数字段: ${Object.keys(s.params).length} 个`);
    console.log(`  ${Object.keys(s.params).join(', ')}`);
    console.log(`Cookie (${s.cookieKeys.length} 个): ${s.cookieKeys.join(', ')}`);
    console.log(`Cookie snippet: ${s.cookieSnippet.substring(0, 200)}...`);
    console.log('');
  }

  // 计算 secsdk 在参数中的位置（每个样本应该有相同的路径？）
  const paths = new Set(samples.map((s) => s.pathname));
  console.log(`\n所有 path 唯一值: ${[...paths].join(', ')}`);

  // 假设 1: secsdk = MD5(timestamp + path)
  console.log('\n=== 假设 1: secsdk = MD5(timestamp + path) ===');
  for (const s of samples) {
    const guess = await md5(s.timestamp + s.pathname);
    const match = guess === s.secsdk ? '✓' : '✗';
    console.log(`${match} ts=${s.timestamp} path=${s.pathname} 实际=${s.secsdk} guess=${guess}`);
  }

  // 假设 2: secsdk = MD5(path + timestamp)
  console.log('\n=== 假设 2: secsdk = MD5(path + timestamp) ===');
  for (const s of samples) {
    const guess = await md5(s.pathname + s.timestamp);
    const match = guess === s.secsdk ? '✓' : '✗';
    console.log(`${match} path=${s.pathname} ts=${s.timestamp} 实际=${s.secsdk} guess=${guess}`);
  }

  // 假设 3: secsdk = MD5(timestamp + "salt" + path)
  console.log('\n=== 假设 3: secsdk = MD5(timestamp + path) 长度 32 ===');
  for (const s of samples) {
    const g1 = await md5(s.timestamp + s.pathname + 'tiktok');
    const g2 = await md5('webmssdk' + s.timestamp + s.pathname);
    console.log(`  ts=${s.timestamp} 实际=${s.secsdk}  salt=tiktok=${g1}  salt=webmssdk=${g2}`);
  }

  // 假设 4: secsdk = MD5(url 完整查询串)
  console.log('\n=== 假设 4: secsdk = MD5(完整查询串) ===');
  for (const s of samples) {
    // 重建查询串
    const usp = new URLSearchParams();
    // 按 a_bogus, msToken, verifyFp, fp, webid, uifid, ... 的顺序
    const order = Object.keys(s.params);
    for (const k of order) usp.append(k, s.params[k]);
    const fullQs = usp.toString();
    const guess = await md5(fullQs);
    console.log(`  qs_len=${fullQs.length} 实际=${s.secsdk}  guess(qs)=${guess}`);
  }

  // 假设 5: MD5(timestamp + a_bogus)
  console.log('\n=== 假设 5: secsdk = MD5(timestamp + a_bogus) ===');
  for (const s of samples) {
    const guess = await md5(s.timestamp + s.aBogus);
    console.log(`  ts=${s.timestamp} 实际=${s.secsdk}  guess=${guess}`);
  }

  // 假设 6: MD5(a_bogus)
  console.log('\n=== 假设 6: secsdk = MD5(a_bogus) ===');
  for (const s of samples) {
    const guess = await md5(s.aBogus);
    console.log(`  实际=${s.secsdk}  guess=${guess}`);
  }
}

async function md5(input: string): Promise<string> {
  const crypto = await import('node:crypto');
  return crypto.createHash('md5').update(input).digest('hex');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
