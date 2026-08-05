/**
 * 解码浏览器生成的 a_bogus，分析其内部 payload 结构
 *
 * 流程：
 *   1. 使用 S4 表逆向 Base64 解码 → raw bytes
 *   2. 分离 prefix(4) + rc4Output
 *   3. 逆向 RC4 变体加密 → rc4Input
 *   4. 分离 versionGarbled(8) + garbledPayload
 *   5. 逆向 garble_3to4 → paddedPayload
 *   6. 打印 payload 各字段的字节值
 *
 * 用法：npx tsx scripts/decode-abogus.ts "<a_bogus_value>"
 */
import { sm3 } from '../src/crypto/abogus.js';

const S4_TABLE = 'Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe';
const S3_TABLE = 'ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe';
const SALT = 'dhzx';
const RC4_KEY = 0xd3;

const MASK_A = 0b10010001;
const MASK_B = 0b01101110;
const MASK_C = 0b01000010;
const MASK_D = 0b10111101;
const MASK_E = 0b00101100;
const MASK_F = 0b11010011;

/** 逆向 S4 Base64 解码 */
function customBase64Decode(str: string, table: string): Uint8Array {
  const lookup = new Map<string, number>();
  for (let i = 0; i < table.length; i++) lookup.set(table[i], i);

  // 移除标准 padding
  const cleanStr = str.replace(/=+$/, '');
  const out: number[] = [];
  for (let i = 0; i < cleanStr.length; i += 4) {
    const c0 = lookup.get(cleanStr[i]) ?? 0;
    const c1 = lookup.get(cleanStr[i + 1]) ?? 0;
    const c2 = lookup.get(cleanStr[i + 2]);
    const c3 = lookup.get(cleanStr[i + 3]);

    const triple = (c0 << 18) | (c1 << 12) | ((c2 ?? 0) << 6) | (c3 ?? 0);
    out.push((triple >> 16) & 0xff);
    if (c2 !== undefined) out.push((triple >> 8) & 0xff);
    if (c3 !== undefined) out.push(triple & 0xff);
  }
  return new Uint8Array(out);
}

/** 逆向 RC4 变体（对称，加密=解密） */
function rc4VariantDecrypt(key: number[], data: Uint8Array): Uint8Array {
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

/** 逆向 garble_3to4：每 4 字节 → 3 字节
 * 编码:
 *   out[0] = (rnd & A) | (data[0] & B)
 *   out[1] = (rnd & C) | (data[1] & D)
 *   out[2] = (rnd & E) | (data[2] & F)
 *   out[3] = (data[0] & A) | (data[1] & C) | (data[2] & E)
 *
 * 解码（掩码互补 A|B=255, C|D=255, E|F=255）:
 *   data[0] = (out[0] & B) | (out[3] & A)
 *   data[1] = (out[1] & D) | (out[3] & C)
 *   data[2] = (out[2] & F) | (out[3] & E)
 */
function ungarble3to4(data: Uint8Array): Uint8Array {
  const outLen = Math.floor(data.length / 4) * 3;
  const out = new Uint8Array(outLen);
  for (let i = 0, j = 0; i + 3 < data.length; i += 4, j += 3) {
    out[j] = (data[i] & MASK_B) | (data[i + 3] & MASK_A);
    out[j + 1] = (data[i + 1] & MASK_D) | (data[i + 3] & MASK_C);
    out[j + 2] = (data[i + 2] & MASK_F) | (data[i + 3] & MASK_E);
  }
  return out;
}

/** 逆向 garble_2to4：4 字节 → 2 字节
 * out[0] = (rnd & 0xAA) | (d0 & 0x55) → d0 = out[0] & 0x55 | out[1] & 0xAA
 * out[1] = (rnd & 0x55) | (d0 & 0xAA) → d0 = out[0] & 0x55 | out[1] & 0xAA
 * out[2] = (rnd & 0xAA) | (d1 & 0x55)
 * out[3] = (rnd & 0x55) | (d1 & 0xAA)
 */
function ungarble2to4(data: Uint8Array): [number, number] {
  const d0 = (data[0] & 0x55) | (data[1] & 0xaa);
  const d1 = (data[2] & 0x55) | (data[3] & 0xaa);
  return [d0, d1];
}

function toHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

function main() {
  const aBogus = process.argv[2];
  if (!aBogus) {
    console.error('用法: npx tsx scripts/decode-abogus.ts "<a_bogus_value>"');
    process.exit(1);
  }

  console.log(`\n=== 解码 a_bogus ===`);
  console.log(`输入 (len=${aBogus.length}): ${aBogus}`);
  console.log(`末尾字符: '${aBogus[aBogus.length - 1]}' (是否为 = 填充: ${aBogus.endsWith('=')})`);

  /* 1. S4 Base64 逆向解码 */
  const finalData = customBase64Decode(aBogus, S4_TABLE);
  console.log(`\n--- 1. S4 Base64 解码 ---`);
  console.log(`finalData 长度: ${finalData.length} 字节`);
  console.log(`finalData (hex): ${toHex(finalData)}`);

  /* 2. 分离 prefix + rc4Output */
  const prefix = finalData.subarray(0, 4);
  const rc4Output = finalData.subarray(4);
  console.log(`\n--- 2. 结构分离 ---`);
  console.log(`prefix (4 字节): ${toHex(prefix)}`);
  console.log(`rc4Output (${rc4Output.length} 字节): ${toHex(rc4Output)}`);

  /* 3. 逆向 RC4 */
  const rc4Input = rc4VariantDecrypt([RC4_KEY], rc4Output);
  console.log(`\n--- 3. RC4 逆向 ---`);
  console.log(`rc4Input (${rc4Input.length} 字节): ${toHex(rc4Input)}`);

  /* 4. 分离 versionGarbled + garbledPayload */
  const versionGarbled = rc4Input.subarray(0, 8);
  const garbledPayload = rc4Input.subarray(8);
  console.log(`\n--- 4. 版本与 Payload 分离 ---`);
  console.log(`versionGarbled (8 字节): ${toHex(versionGarbled)}`);
  console.log(`garbledPayload (${garbledPayload.length} 字节): ${toHex(garbledPayload)}`);

  /* 5. 逆向 garble_2to4 (version) */
  const v1 = ungarble2to4(versionGarbled.subarray(0, 4));
  const v2 = ungarble2to4(versionGarbled.subarray(4, 8));
  console.log(`\n--- 5. 版本号解码 ---`);
  console.log(`version[0] = garble2to4(${versionGarbled.subarray(0, 4).join(',')}) → [${v1[0]}, ${v1[1]}]`);
  console.log(`version[1] = garble2to4(${versionGarbled.subarray(4, 8).join(',')}) → [${v2[0]}, ${v2[1]}]`);

  /* 6. 逆向 prefix */
  const prefixDecoded = ungarble2to4(prefix);
  console.log(`prefix = garble2to4(${prefix.join(',')}) → [${prefixDecoded[0]}, ${prefixDecoded[1]}]`);

  /* 7. 逆向 garble_3to4 */
  const paddedPayload = ungarble3to4(garbledPayload);
  console.log(`\n--- 6. garble_3to4 逆向 ---`);
  console.log(`paddedPayload (${paddedPayload.length} 字节): ${toHex(paddedPayload)}`);

  /* 8. 分析 payload 结构 */
  console.log(`\n--- 7. Payload 结构分析 ---`);
  const p = paddedPayload;
  let offset = 0;

  // 时间戳 6 字节
  const tsBytes = Array.from(p.subarray(0, 6));
  offset = 6;
  const ts = tsBytes.reduce((acc, b, i) => acc + BigInt(b) * (1n << BigInt(i * 8)), 0n);
  console.log(`[${offset}] 时间戳 (6 字节): ${tsBytes.join(', ')} → ${ts} → ${new Date(Number(ts)).toISOString()}`);

  // 随机因子 4 字节
  const randBytes = Array.from(p.subarray(offset, offset + 4));
  console.log(`[${offset + 4}] 随机因子 (4 字节): ${randBytes.join(', ')}`);
  offset += 4;

  // URL 哈希 3 字节
  const urlHashBytes = Array.from(p.subarray(offset, offset + 3));
  console.log(`[${offset + 3}] URL哈希 (3 字节, idx [9,18,3]): ${urlHashBytes.join(', ')}`);
  offset += 3;

  // Body 哈希 3 字节
  const bodyHashBytes = Array.from(p.subarray(offset, offset + 3));
  console.log(`[${offset + 3}] Body哈希 (3 字节, idx [10,19,4]): ${bodyHashBytes.join(', ')}`);
  offset += 3;

  // UA 哈希 3 字节
  const uaHashBytes = Array.from(p.subarray(offset, offset + 3));
  console.log(`[${offset + 3}] UA哈希 (3 字节, idx [11,21,5]): ${uaHashBytes.join(', ')}`);
  offset += 3;

  // debugFlag 1 字节
  const debugFlag = p[offset];
  console.log(`[${offset + 1}] debugFlag (1 字节): ${debugFlag}`);
  offset += 1;

  // timeDiff 1 字节
  const timeDiff = p[offset];
  console.log(`[${offset + 1}] timeDiff (1 字节): ${timeDiff}`);
  offset += 1;

  // browserRand 1 字节
  const browserRand = p[offset];
  console.log(`[${offset + 1}] browserRand (1 字节): ${browserRand}`);
  offset += 1;

  // sLen 1 字节
  const sLen = p[offset];
  console.log(`[${offset + 1}] sLen (1 字节): ${sLen}`);
  offset += 1;

  // tLen 1 字节
  const tLen = p[offset];
  console.log(`[${offset + 1}] tLen (1 字节): ${tLen}`);
  offset += 1;

  // magic 1 字节
  const magic = p[offset];
  console.log(`[${offset + 1}] magic (1 字节): ${magic} (期望 41)`);
  offset += 1;

  console.log(`\n当前 offset = ${offset} (固定域结束)`);
  console.log(`剩余字节: ${p.length - offset} (sLen + tLen + 1 checksum = ${sLen} + ${tLen} + 1 = ${sLen + tLen + 1})`);

  // 可变域：设备信息 sLen 字节
  const deviceBytes = p.subarray(offset, offset + sLen);
  const deviceStr = new TextDecoder().decode(deviceBytes);
  console.log(`\n[${offset + sLen}] 设备信息 (${sLen} 字节): "${deviceStr}"`);
  console.log(`  hex: ${toHex(deviceBytes)}`);
  offset += sLen;

  // 时间编码 tLen 字节
  const timeBytes = p.subarray(offset, offset + tLen);
  const timeStr = new TextDecoder().decode(timeBytes);
  console.log(`[${offset + tLen}] 时间编码 (${tLen} 字节): "${timeStr}"`);
  offset += tLen;

  // 校验和 1 字节
  const checksum = p[offset];
  console.log(`[${offset + 1}] checksum (1 字节): ${checksum}`);

  // 计算预期校验和
  let expectedChecksum = 0;
  for (let i = 0; i < offset; i++) expectedChecksum ^= p[i];
  console.log(`  预期 checksum (XOR): ${expectedChecksum} ${expectedChecksum === checksum ? '✓' : '✗'}`);

  // 剩余字节（如果有）
  offset += 1;
  if (offset < p.length) {
    const remaining = p.subarray(offset);
    console.log(`\n[!] 剩余 ${remaining.length} 字节未解析: ${toHex(remaining)}`);
    console.log(`    (as string): "${new TextDecoder().decode(remaining)}"`);
  } else {
    console.log(`\n✓ Payload 完全解析，无剩余字节`);
  }
}

main();
