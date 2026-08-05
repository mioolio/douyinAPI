/* 提取 bdms.js 中 J("...base64...") 调用中的 base64 字符串，并解码出 Z 字符串常量表 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const file = path.join(__dirname, '..', 'data', 'capture', 'bdms.js');
const src = fs.readFileSync(file, 'utf-8');

console.log('=== 1. 提取 base64 字节码字符串 ===');
const iifeStart = src.indexOf('}("', 91657);
console.log('IIFE 起始位置:', iifeStart);
const b64Start = iifeStart + 2;
const b64End = src.indexOf('")', b64Start);
const b64 = src.slice(b64Start, b64End);
console.log('base64 字符串长度:', b64.length);

console.log('\n=== 2. atob 解码 ===');
const decoded = Buffer.from(b64, 'base64');
console.log('解码后字节数:', decoded.length);
console.log('前 16 字节 hex:', [...decoded.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join(' '));
console.log('前 8 字节 (header):', [...decoded.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join(' '));

console.log('\n=== 3. 计算解密密钥 ===');
let keySum = 0;
for (let i = 4; i < 8; i++) keySum += decoded[i];
const key = keySum % 256;
console.log('密钥 (bytes[4..7] sum % 256):', key);

console.log('\n=== 4. XOR 解密 (Uint8Array.from(r.slice(8), _, key)) ===');
// _ 函数: (t.charCodeAt(0) ^ (this + this%10*r) % 256) >>> 0
// this = key, r = index
// 注意: t 是 binary string 的字符, charCodeAt(0) 返回该字符的 charCode
const decrypted = [];
for (let i = 8; i < decoded.length; i++) {
  const byte = decoded[i];
  const r = i - 8; // index
  const ks = (key + (key % 10) * r) % 256;
  decrypted.push((byte ^ ks) & 0xff);
}
console.log('解密后字节数:', decrypted.length);
console.log('前 32 字节 hex:', decrypted.slice(0, 32).map(b => b.toString(16).padStart(2, '0')).join(' '));

console.log('\n=== 5. C() 解压 (fflate inflate, i:2 = raw inflate) ===');
let inflated;
try {
  inflated = zlib.inflateRawSync(Buffer.from(decrypted));
  console.log('inflateRaw 成功! 解压后字节数:', inflated.length);
  console.log('前 32 字节 hex:', [...inflated.slice(0, 32)].map(b => b.toString(16).padStart(2, '0')).join(' '));
  console.log('前 64 字节 printable:', [...inflated.slice(0, 64)].map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join(''));
} catch (e) {
  console.log('inflateRaw 失败:', e.message);
  // 尝试其他解压方式
  try {
    inflated = zlib.inflateSync(Buffer.from(decrypted));
    console.log('inflate (zlib header) 成功! 字节数:', inflated.length);
  } catch (e2) {
    console.log('inflate 也失败:', e2.message);
    try {
      inflated = zlib.gunzipSync(Buffer.from(decrypted));
      console.log('gunzip 成功! 字节数:', inflated.length);
    } catch (e3) {
      console.log('所有解压方式都失败');
      console.log('可能解密步骤有误，检查 _ 函数实现');
      process.exit(1);
    }
  }
}

// 现在使用解压后的字节流
const bytes = Array.from(inflated);
console.log('\n使用解压后字节流进行解析, 总长度:', bytes.length);

console.log('\n=== 6. varint 读取 (W 函数) ===');
function W(state) {
  let r = 0, e = 0;
  while (true) {
    const n = state.d[state.i++];
    r |= (127 & n) << e;
    e += 7;
    if (!(128 & n)) {
      return e < 32 && (64 & n) ? r | (-1 << e) : r;
    }
  }
}

console.log('\n=== 7. UTF-8 字符串读取 (K 函数) ===');
function K(state) {
  let r = -1;
  const e = [];
  while (true) {
    const n = state.d[state.i++];
    if (n >= 128 && n < 192) {
      r = (r << 6) + (63 & n);
    } else {
      if (r >= 0) e.push(r);
      if (n < 128) {
        r = n;
      } else if (n < 224) {
        r = 31 & n;
      } else if (n < 240) {
        r = 15 & n;
      } else {
        if (!(n < 248)) break;
        r = 7 & n;
      }
    }
  }
  return String.fromCodePoint.apply(null, e);
}

console.log('\n=== 8. 解析 Z 字符串常量池 ===');
const state = { d: bytes, i: 0 };
const Z = [];
const z = [];

try {
  const zCount = W(state);
  console.log('Z 字符串数量:', zCount);
  if (zCount < 0 || zCount > 100000) {
    console.log('Z 数量异常，解密可能仍有问题');
    process.exit(1);
  }
  for (let i = 0; i < zCount; i++) {
    Z.push(K(state));
  }
  console.log('Z 表已加载，元素数:', Z.length);

  // 跳过 z 函数表，不解析具体内容（节省时间）
  const funcCount = W(state);
  console.log('z 函数数量:', funcCount);
} catch (e) {
  console.log('解析失败:', e.message);
  console.log('当前 state.i:', state.i);
}

console.log('\n=== 9. 查找 dhzx 盐值 ===');
const dhzxIdx = Z.indexOf('dhzx');
console.log('dhzx 在 Z 表索引:', dhzxIdx);
if (dhzxIdx >= 0) {
  console.log('  -> 值:', JSON.stringify(Z[dhzxIdx]));
}

console.log('\n=== 10. 查找 64 字符 base64 表 ===');
Z.forEach((s, i) => {
  if (s.length === 64 && /^[A-Za-z0-9+/_=\-]+$/.test(s)) {
    const unique = new Set(s).size;
    console.log(`  Z[${i}] len=64 unique=${unique}: ${s}`);
  }
});

console.log('\n=== 11. 查找短字符串 (盐值/关键字) ===');
Z.forEach((s, i) => {
  if (s.length >= 3 && s.length <= 8 && /^[a-z0-9_]+$/i.test(s)) {
    console.log(`  Z[${i}] = ${JSON.stringify(s)}`);
  }
});

console.log('\n=== 12. 查找 a_bogus / msToken 等关键字 ===');
['a_bogus', 'msToken', 'verifyFp', 'X-Bogus', 'a-bogus', 'fp', 's_v_web_id', 'bd-ticket', 'webmssdk', 'sdk-glue', 'dhzx', 's3', 's4', 's5', 'navigator', 'userAgent', 'Math', 'random', 'Date', 'now'].forEach(kw => {
  const idx = Z.indexOf(kw);
  if (idx >= 0) {
    console.log(`  ${kw}: Z[${idx}]`);
  } else {
    // 部分匹配
    const partial = Z.findIndex(s => typeof s === 'string' && s.includes(kw));
    if (partial >= 0) {
      console.log(`  ${kw}: 部分匹配 Z[${partial}] = ${JSON.stringify(Z[partial].slice(0, 80))}`);
    } else {
      console.log(`  ${kw}: 未找到`);
    }
  }
});

console.log('\n=== 13. 输出全部 Z 字符串表 ===');
Z.forEach((s, i) => {
  const display = s.length > 100 ? s.slice(0, 100) + '...' : s;
  console.log(`  [${i}] len=${s.length}: ${JSON.stringify(display)}`);
});

// 保存到文件
const outFile = path.join(__dirname, '..', 'data', 'capture', 'bdms-Z-table.json');
fs.writeFileSync(outFile, JSON.stringify({ Z, count: Z.length, dhzxIdx, tables: Z.filter(s => s.length === 64) }, null, 2));
console.log(`\n=== 14. 已保存到 ${outFile} ===`);
