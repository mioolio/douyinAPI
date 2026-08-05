/**
 * 解码真实浏览器 a_bogus
 * 输入：data/probe-xhr-hook.json 中的 finalRequests[1] (notice API)
 */
import { readFileSync } from 'fs';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('decode-real');

const S4_TABLE = 'Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe';
const S3_TABLE = 'ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe';
const RC4_KEY = 0xd3;

const MASK_A = 0b10010001;
const MASK_B = 0b01101110;
const MASK_C = 0b01000010;
const MASK_D = 0b10111101;
const MASK_E = 0b00101100;
const MASK_F = 0b11010011;
const MASK_AA = 0xaa;
const MASK_55 = 0x55;

function customBase64Decode(s: string, table: string): Uint8Array {
  // 处理 URL-safe 字符
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const padding = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const core = padding > 0 ? s.slice(0, -padding) : s;
  const out: number[] = [];
  for (let i = 0; i < core.length; i += 4) {
    const c0 = table.indexOf(core[i]);
    const c1 = table.indexOf(core[i + 1]);
    const c2 = i + 2 < core.length ? table.indexOf(core[i + 2]) : -1;
    const c3 = i + 3 < core.length ? table.indexOf(core[i + 3]) : -1;
    if (c0 < 0 || c1 < 0) break;
    out.push((c0 << 2) | (c1 >> 4));
    if (c2 >= 0) {
      out.push(((c1 & 0xf) << 4) | (c2 >> 2));
      if (c3 >= 0) {
        out.push(((c2 & 0x3) << 6) | c3);
      }
    }
  }
  return new Uint8Array(out);
}

function rc4Variant(key: number[], data: Uint8Array): Uint8Array {
  const len = key.length;
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = 255 - i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j * S[i] + j + key[i % len]) % 256;
    const tmp = S[i];
    S[i] = S[j];
    S[j] = tmp;
  }
  const out = new Uint8Array(data.length);
  let i2 = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i2 = (i2 + 1) % 256;
    j = (j + S[i2]) % 256;
    const tmp = S[i2];
    S[i2] = S[j];
    S[j] = tmp;
    const t = (S[i2] + S[j]) % 256;
    out[k] = data[k] ^ S[t];
  }
  return out;
}

function ungarble3to4(garbled: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < garbled.length; i += 4) {
    const o0 = garbled[i], o1 = garbled[i + 1], o2 = garbled[i + 2], o3 = garbled[i + 3];
    const d0 = (o0 & MASK_B) | (o3 & MASK_A);
    const d1 = (o1 & MASK_D) | (o3 & MASK_C);
    const d2 = (o2 & MASK_F) | (o3 & MASK_E);
    out.push(d0, d1, d2);
  }
  return new Uint8Array(out);
}

function ungarble2to4(garbled: Uint8Array): [number, number] {
  return [
    (garbled[0] & MASK_55) | (garbled[1] & MASK_AA),
    (garbled[2] & MASK_55) | (garbled[3] & MASK_AA),
  ];
}

function toHex(buf: Uint8Array, maxLen = 80): string {
  const slice = buf.slice(0, maxLen);
  return Array.from(slice).map((b) => b.toString(16).padStart(2, '0')).join(' ') + (buf.length > maxLen ? '...' : '');
}

function toAscii(buf: Uint8Array, maxLen = 100): string {
  const slice = buf.slice(0, maxLen);
  return Array.from(slice).map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : `.`)).join('') + (buf.length > maxLen ? '...' : '');
}

// 读取捕获的 a_bogus
const data = JSON.parse(readFileSync('d:/Desktop/DYCC/SPRR/data/probe-xhr-hook.json', 'utf-8'));
const abTests = (data.finalRequests as Array<{ url: string; method: string; postData: string }>).filter((r) => r.url.includes('a_bogus='));

log.info(`找到 ${abTests.length} 个含 a_bogus 的请求`);

for (let idx = 0; idx < abTests.length; idx++) {
  const r = abTests[idx];
  const u = new URL(r.url);
  const aBogus = u.searchParams.get('a_bogus') || '';
  log.info(`\n=========================================`);
  log.info(`请求 ${idx + 1}: ${r.method} ${u.pathname}`);
  log.info(`a_bogus 长度: ${aBogus.length}`);
  log.info(`a_bogus: ${aBogus}`);

  // 1. s4 解码
  const decoded = customBase64Decode(aBogus, S4_TABLE);
  log.info(`\n[1] s4 解码后字节数: ${decoded.length}`);

  // 2. 拆 prefix (4 bytes)
  const prefix = decoded.slice(0, 4);
  const rc4Input = decoded.slice(4);
  const [p0, p1] = ungarble2to4(prefix);
  log.info(`[2] prefix → [${p0}, ${p1}], rc4Input 长度: ${rc4Input.length}`);

  // 3. RC4 解密
  const decrypted = rc4Variant([RC4_KEY], rc4Input);
  log.info(`[3] RC4 解密后长度: ${decrypted.length}`);

  // 4. 拆 version (8 bytes) + garbled payload
  const versionGarbled = decrypted.slice(0, 8);
  const garbledPayload = decrypted.slice(8);
  const v1 = ungarble2to4(versionGarbled.slice(0, 4));
  const v2 = ungarble2to4(versionGarbled.slice(4, 8));
  log.info(`[4] version: v1=[${v1[0]},${v1[1]}] v2=[${v2[0]},${v2[1]}], garbled 长度: ${garbledPayload.length}`);

  // 5. 反向 garble_3to4
  const payload = ungarble3to4(garbledPayload);
  log.info(`[5] payload 长度: ${payload.length}`);

  // 6. 拆固定域
  const fixed = payload.slice(0, 25);
  const variable = payload.slice(25, -1);
  const checksum = payload[payload.length - 1];
  log.info(`[6] 固定域 (25) + 可变域 (${variable.length}) + checksum (1)`);

  // 7. 详细分析固定域
  log.info(`\n[7] 固定域字节:`);
  log.info(`    [0-5] timestamp: ${toHex(fixed.slice(0, 6))}`);
  log.info(`    [6-9] random: ${toHex(fixed.slice(6, 10))}`);
  log.info(`    [10-12] url_hash: ${toHex(fixed.slice(10, 13))}`);
  log.info(`    [13-15] body_hash: ${toHex(fixed.slice(13, 16))}`);
  log.info(`    [16-18] ua_hash: ${toHex(fixed.slice(16, 19))}`);
  log.info(`    [19] debugFlag: ${fixed[19]}`);
  log.info(`    [20] timeDiff: ${fixed[20]}`);
  log.info(`    [21] browserRand: ${fixed[21]}`);
  log.info(`    [22] sLen: ${fixed[22]}`);
  log.info(`    [23] tLen: ${fixed[23]}`);
  log.info(`    [24] MAGIC: ${fixed[24]}`);

  // 8. 解析可变域
  const sLen = fixed[22];
  const tLen = fixed[23];
  const deviceBytes = variable.slice(0, sLen);
  const timeBytes = variable.slice(sLen, sLen + tLen);
  log.info(`\n[8] sLen=${sLen}, tLen=${tLen}`);
  log.info(`    device info: "${toAscii(deviceBytes)}"`);
  log.info(`    device hex: ${toHex(deviceBytes, 40)}`);
  log.info(`    time encoding: "${toAscii(timeBytes)}"`);

  // 9. 时间戳
  const ts = fixed[0] | (fixed[1] << 8) | (fixed[2] << 16) | (fixed[3] << 24) | (fixed[4] * 0x100000000) | (fixed[5] * 0x10000000000);
  log.info(`\n[9] timestamp ms: ${ts}`);
  log.info(`    Date: ${new Date(ts).toISOString()}`);

  // 10. 完整 URL 参数（用于验证 url_hash）
  const urlParams = Array.from(u.searchParams.entries())
    .filter(([k]) => k !== 'a_bogus' && k !== 'X-Bogus')
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  log.info(`\n[10] URL params (without a_bogus):`);
  log.info(`     ${urlParams.substring(0, 400)}...`);
}
