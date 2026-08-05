/**
 * 反向解密浏览器 a_bogus，还原原始 payload 字节
 *
 * 流程：
 *   1. 用 s4 表解码 a_bogus 字符串 → 字节
 *   2. 去掉前 4 字节 prefix（garble_2to4 输出）
 *   3. RC4 变体解密剩余字节（key=0xD3）
 *   4. 反向 garble_3to4 → 原始 payload
 *   5. 与我们生成的 payload 对比
 */
import { generateABogus, sm3 } from '../src/crypto/abogus.js';

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

function customBase64Encode(data: Uint8Array, table: string): string {
  let out = '';
  const len = data.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = data[i];
    const b1 = i + 1 < len ? data[i + 1] : 0;
    const b2 = i + 2 < len ? data[i + 2] : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += table[(triple >> 18) & 0x3f];
    out += table[(triple >> 12) & 0x3f];
    if (i + 1 < len) out += table[(triple >> 6) & 0x3f];
    if (i + 2 < len) out += table[triple & 0x3f];
  }
  return out;
}

function rc4Variant(key: number[], data: Uint8Array): Uint8Array {
  const len = key.length;
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = 255 - i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j * S[i] + j + key[i % len]) % 256;
    [S[i], S[j]] = [S[j], S[i]];
  }
  const out = new Uint8Array(data.length);
  let i2 = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i2 = (i2 + 1) % 256;
    j = (j + S[i2]) % 256;
    [S[i2], S[j]] = [S[j], S[i2]];
    const t = (S[i2] + S[j]) % 256;
    out[k] = data[k] ^ S[t];
  }
  return out;
}

/** 反向 garble_3to4：从 4 字节反推 3 字节
 * out[0] = (rnd & A) | (data[0] & B)
 * out[1] = (rnd & C) | (data[1] & D)
 * out[2] = (rnd & E) | (data[2] & F)
 * out[3] = (data[0] & A) | (data[1] & C) | (data[2] & E)
 *
 * 反推：
 *   data[0] 的高 7 位（A 的位）= out[3] & A
 *   data[0] 的低 1 位（B 的最高位）？out[0] & MASK_A_low = ... 难精确反推
 *   但 A|B = 255 所以 out[0] 包含 (data[0] & B) 部分 = (data[0] & 11011110)
 *   实际上：A = 10010001 = 0x91，B = 01101110 = 0x6E
 *   out[0] = (rnd & 0x91) | (data[0] & 0x6E)
 *   out[3] = (data[0] & 0x91) | (data[1] & 0x42) | (data[2] & 0x2C)
 */
function ungarble3to4(garbled: Uint8Array): Uint8Array {
  // 简单的反向尝试：每个 garble 块用穷举找出 data
  // 实际生产中 webmssdk 不反向，但我们可以用启发式：
  // 假设 rnd 是某字节，那么：
  //   data[0] = (out[0] & 0x6E) | (out[3] & 0x91)  -- 但 out[0] 实际是 (rnd & 0x91) | (data[0] & 0x6E)
  //   即 data[0] 的低 7 位 = out[0] & 0x6E (假设 rnd 最高位不影响)
  // 实际算法不可逆因为有 rnd 噪声，只能看 out[3] = (data[0] & 0x91) | (data[1] & 0x42) | (data[2] & 0x2C)
  const out: number[] = [];
  for (let i = 0; i < garbled.length; i += 4) {
    const o0 = garbled[i], o1 = garbled[i + 1], o2 = garbled[i + 2], o3 = garbled[i + 3];
    // out[3] = (d0 & A) | (d1 & C) | (d2 & E)
    // 启发式：d0 = (o0 & B) | (o3 & A)  -- 假设 rnd 噪声不影响
    // 实际：因为 A = 10010001，B = 01101110
    //   d0 = (o0 & B) | (o3 & A) 不一定准，但 (o3 & A) 直接给出 d0 的高 7 位
    //   (o0 & B) 给 d0 的低 7 位（B 的位）
    //   巧合：A 和 B 互补（合起来是 0xFF），所以 (o0 & B) | (o3 & A) 实际等于 d0
    //     因为 (o0 & B) = (rnd & A & B) | (d0 & B & B) = 0 | (d0 & B) = d0 & B
    //     (o3 & A) = (d0 & A & A) | ... = d0 & A
    //     相加 = d0 & (A | B) = d0 & 0xFF = d0
    const d0 = (o0 & MASK_B) | (o3 & MASK_A);
    const d1 = (o1 & MASK_D) | (o3 & MASK_C);
    const d2 = (o2 & MASK_F) | (o3 & MASK_E);
    out.push(d0, d1, d2);
  }
  return new Uint8Array(out);
}

/** 反向 garble_2to4 */
function ungarble2to4(garbled: Uint8Array): [number, number] {
  // garble_2to4(d0, d1) 输出 4 字节
  //   out[0] = (rnd & 0xAA) | (d0 & 0x55)
  //   out[1] = (rnd & 0x55) | (d0 & 0xAA)
  //   out[2] = (rnd & 0xAA) | (d1 & 0x55)
  //   out[3] = (rnd & 0x55) | (d1 & 0xAA)
  // 反向：d0 = (out[0] & 0x55) | (out[1] & 0xAA)
  //       d1 = (out[2] & 0x55) | (out[3] & 0xAA)
  // 原因同 garble_3to4：A 和 B 互补
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

const SAMPLE = 'D70RgHUEx2/VFdMbmOj5y6/lqhylNBSyIliKWEpPyOu9PXFO4SNbKOc/nxqFBuEvbYp0k9V7pnt/bEdcYzUTZo9kumpfudif5t2In0moZqqXTzJsDHjkCz8zowBFUOiEa5nXNlJ5As0rIxQlnNIhAp-a95zqQQRpbrMRd/TyGDS03TLTno2XeavW/qE=';

console.log('========== 浏览器 a_bogus 反向分析 ==========');
console.log(`原始长度: ${SAMPLE.length} 字符`);

// 1. 解码
const decoded = customBase64Decode(SAMPLE, S4_TABLE);
console.log(`\n[1] s4 解码后字节数: ${decoded.length}`);
console.log(`    hex: ${toHex(decoded, 50)}`);

// 2. 拆 prefix (4 bytes)
const prefix = decoded.slice(0, 4);
const rc4Input = decoded.slice(4);
console.log(`\n[2] prefix (4 bytes): ${toHex(prefix)} = ${toAscii(prefix)}`);
console.log(`    rc4Input 长度: ${rc4Input.length}`);

// 反向 garble_2to4 得到 [3, 82] (应该得到 version info)
const [p0, p1] = ungarble2to4(prefix);
console.log(`    prefix 反向 garble_2to4 → [${p0}, ${p1}]`);

// 3. RC4 解密
const decrypted = rc4Variant([RC4_KEY], rc4Input);
console.log(`\n[3] RC4 解密后长度: ${decrypted.length}`);
console.log(`    hex: ${toHex(decrypted, 60)}`);

// 4. 拆 version (8 bytes) + garbled payload
const versionGarbled = decrypted.slice(0, 8);
const garbledPayload = decrypted.slice(8);
console.log(`\n[4] versionGarbled (8 bytes): ${toHex(versionGarbled)}`);
const v1 = ungarble2to4(versionGarbled.slice(0, 4));
const v2 = ungarble2to4(versionGarbled.slice(4, 8));
console.log(`    v1 = [${v1[0]}, ${v1[1]}]  (version 1)`);
console.log(`    v2 = [${v2[0]}, ${v2[1]}]  (version 2)`);
console.log(`\n    garbledPayload 长度: ${garbledPayload.length}`);

// 5. 反向 garble_3to4
const payload = ungarble3to4(garbledPayload);
console.log(`\n[5] payload 长度: ${payload.length}`);
console.log(`    hex: ${toHex(payload, 80)}`);
console.log(`    ascii: ${toAscii(payload, 80)}`);

// 6. 拆 payload: 前 25 字节固定 + 可变域
const fixed = payload.slice(0, 25);
const variable = payload.slice(25, -1);
const checksum = payload[payload.length - 1];
console.log(`\n[6] 固定域 (25 字节): ${toHex(fixed)}`);
console.log(`    可变域长度: ${variable.length} 字节`);
console.log(`    校验和: 0x${checksum.toString(16).padStart(2, '0')}`);

// 7. 详细分析固定域
console.log(`\n[7] 固定域字节:`);
console.log(`    [0-5] timestamp (6 字节): ${toHex(fixed.slice(0, 6))}`);
console.log(`    [6-9] random (4 字节): ${toHex(fixed.slice(6, 10))}`);
console.log(`    [10-12] url_hash: ${toHex(fixed.slice(10, 13))}`);
console.log(`    [13-15] body_hash: ${toHex(fixed.slice(13, 16))}`);
console.log(`    [16-18] ua_hash: ${toHex(fixed.slice(16, 19))}`);
console.log(`    [19] debugFlag: ${fixed[19]}`);
console.log(`    [20] timeDiff: ${fixed[20]}`);
console.log(`    [21] browserRand: ${fixed[21]}`);
console.log(`    [22] sLen (variable length): ${fixed[22]}`);
console.log(`    [23] tLen (time length): ${fixed[23]}`);
console.log(`    [24] MAGIC: ${fixed[24]}`);

// 8. 解析可变域
console.log(`\n[8] 可变域 (${variable.length} 字节):`);
const sLen = fixed[22];
const tLen = fixed[23];
console.log(`    sLen=${sLen}, tLen=${tLen}, sum=${sLen + tLen} (实际 ${variable.length})`);
const deviceBytes = variable.slice(0, sLen);
const timeBytes = variable.slice(sLen, sLen + tLen);
console.log(`    device info (${deviceBytes.length}): ${toAscii(deviceBytes)}`);
console.log(`    time encoding (${timeBytes.length}): ${toAscii(timeBytes)}`);

// 9. 反推 timestamp
const ts = fixed[0] | (fixed[1] << 8) | (fixed[2] << 16) | (fixed[3] << 24) | (fixed[4] * 0x100000000) | (fixed[5] * 0x10000000000);
console.log(`\n[9] timestamp (ms): ${ts}`);
console.log(`    Date: ${new Date(ts).toISOString()}`);

console.log('\n\n========== 对比：我们生成的 a_bogus ==========');
const ourABogus = generateABogus({
  url: '/aweme/v1/web/social/count',
  params: { device_platform: 'webapp', aid: '6383' },
  method: 'GET',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  body: '',
});
console.log(`长度: ${ourABogus.length} 字符`);
const ourDecoded = customBase64Decode(ourABogus + (ourABogus.length % 4 === 2 ? '==' : ourABogus.length % 4 === 3 ? '=' : ''), S4_TABLE);
console.log(`解码字节数: ${ourDecoded.length}`);
const ourRc4Input = ourDecoded.slice(4);
const ourDecrypted = rc4Variant([RC4_KEY], ourRc4Input);
const ourPayload = ungarble3to4(ourDecrypted.slice(8));
console.log(`我们 payload 长度: ${ourPayload.length}`);
console.log(`我们 device info: ${toAscii(ourPayload.slice(25, 25 + ourPayload[22]))}`);
