/* 从 bdms.js 中提取所有可能的 Base64 编码表（64 字符或 63 字符的字符串） */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'data', 'capture', 'bdms.js');
const src = fs.readFileSync(file, 'utf-8');

console.log('文件大小:', src.length);

// 匹配所有 60-66 字符的字符串字面量（双引号或单引号）
const re = /(["'])(([A-Za-z0-9+/_=\-]){60,66})\1/g;
const found = new Set();
let m;
while ((m = re.exec(src)) !== null) {
  found.add(m[2]);
}
console.log('\n=== 60-66 字符的字符串 ===');
for (const s of found) {
  // 检查字符多样性（base64 表应该有 60+ 不同字符）
  const unique = new Set(s).size;
  console.log(`长度=${s.length} 独特字符=${unique}: ${s}`);
}

// 也查找 30-40 字符的字符串（可能是 s3 的 padding-less 变体）
const re2 = /(["'])(([A-Za-z0-9+/_=\-]){30,50})\1/g;
const found2 = new Set();
while ((m = re2.exec(src)) !== null) {
  const s = m[2];
  const unique = new Set(s).size;
  // 只打印独特字符 >= 25 的
  if (unique >= 25) {
    found2.add(s);
  }
}
console.log('\n=== 30-50 字符的字符串（独特字符>=25）===');
for (const s of found2) {
  const unique = new Set(s).size;
  console.log(`长度=${s.length} 独特字符=${unique}: ${s}`);
}

// 查找 dhzx 盐值
const idx = src.indexOf('dhzx');
console.log('\n=== dhzx 盐值 ===');
console.log('位置:', idx);
if (idx >= 0) {
  console.log('上下文:', src.slice(Math.max(0, idx - 50), idx + 50));
}

// 查找 "s3" 和 "s4" 关键字
console.log('\n=== s3 / s4 / s5 关键字 ===');
for (const k of ['s3', 's4', 's5', 's1', 's2']) {
  const reK = new RegExp(`["']${k}["']\\s*[:,]`, 'g');
  const matches = [];
  while ((m = reK.exec(src)) !== null) {
    matches.push(src.slice(Math.max(0, m.index - 10), m.index + 100));
  }
  console.log(`${k}: ${matches.length} 处`);
  for (const x of matches.slice(0, 3)) console.log(`  ${x}`);
}

// 查找 "dhzx" 之外可能的盐值
console.log('\n=== 其他 4 字符盐值候选 ===');
const reSalt = /["']([a-z]{4})["']/g;
const salts = new Set();
while ((m = reSalt.exec(src)) !== null) {
  salts.add(m[1]);
}
console.log('总数:', salts.size);
for (const s of salts) console.log(`  ${s}`);
