/* 分析 webmssdk.es5.js 结构：找 a_bogus / msToken / 签名相关入口 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'data', 'capture', 'webmssdk.es5.js');
const src = fs.readFileSync(file, 'utf-8');

console.log(`文件大小: ${src.length} 字节\n`);

// 1. 全局对象 / 函数定义
const patterns = [
  { name: 'window 暴露', re: /window\.\w+\s*=/g },
  { name: 'byted_acrawler', re: /byted_acrawler/g },
  { name: 'frontierSign', re: /frontierSign/g },
  { name: 'a_bogus 字符串', re: /a_bogus/g },
  { name: 'msToken 字符串', re: /msToken/g },
  { name: 'verifyFp', re: /verifyFp/g },
  { name: 'X-Bogus', re: /X-Bogus/g },
  { name: '_signature', re: /_signature/g },
];

for (const { name, re } of patterns) {
  const matches = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    matches.push(m.index);
    if (matches.length >= 5) break;
  }
  console.log(`${name}: ${matches.length === 0 ? '未找到' : matches.slice(0, 5).join(', ')}`);
}

console.log('\n=== window.XX = ... 暴露的全局 ===');
const winRe = /window\.(\w+)\s*=/g;
let m;
const exposed = new Set();
while ((m = winRe.exec(src)) !== null) {
  exposed.add(m[1]);
}
console.log([...exposed].sort().join(', '));

console.log('\n=== 字符串数组解密（开头部分） ===');
// 通常 webmssdk 开头是一个大数组，里面是被加密的字符串
const arrMatch = src.match(/^[\s\S]{0,2000}function\s+\w+\(\)\s*\{[\s\S]*?return\s*\w+\}/);
if (arrMatch) {
  console.log(`开头 ${arrMatch[0].length} 字节:`);
  console.log(arrMatch[0].slice(0, 500));
}

console.log('\n=== 函数定义统计 ===');
const fnDefCount = (src.match(/function\s+\w+\s*\(/g) || []).length;
const arrowFnCount = (src.match(/=>\s*[{(]/g) || []).length;
console.log(`function 定义: ${fnDefCount}`);
console.log(`箭头函数: ${arrowFnCount}`);

console.log('\n=== 寻找可疑的字符串解密函数 ===');
// 通常会有形如 function X(idx) { return arr[idx - offset]; }
const decryptRe = /function\s+(\w+)\s*\((\w+)\)\s*\{\s*return\s+(\w+)\[(\w+)\s*-\s*(\d+)\]\s*\}/g;
while ((m = decryptRe.exec(src)) !== null) {
  console.log(`  解密函数: ${m[1]}(idx) => ${m[3]}[idx - ${m[5]}]`);
  // 查找这个函数被调用的次数
  const callRe = new RegExp(`\\b${m[1]}\\(`, 'g');
  const callCount = (src.match(callRe) || []).length;
  console.log(`    被调用 ${callCount} 次`);
  // 找到这个函数定义位置，往后打印一些上下文
  const start = m.index;
  console.log(`    位置: ${start}`);
}

console.log('\n=== 寻找可疑的字符串字面量数组 ===');
// 数组 ['string1', 'string2', ...]
const arrLitRe = /\[\s*("(?:[^"\\]|\\.)*"\s*,\s*){5,}/g;
let found = 0;
while ((m = arrLitRe.exec(src)) !== null && found < 3) {
  found++;
  const start = m.index;
  const slice = src.slice(start, start + 400);
  console.log(`  位置 ${start}: ${slice.slice(0, 200)}...`);
}

console.log('\n=== 寻找 XMLHttpRequest hook ===');
const xhrRe = /XMLHttpRequest/g;
let xhrIdx = 0;
while ((m = xhrRe.exec(src)) !== null && xhrIdx < 3) {
  xhrIdx++;
  const ctx = src.slice(Math.max(0, m.index - 80), m.index + 200);
  console.log(`\n位置 ${m.index}:\n  ${ctx.replace(/\n/g, '\n  ')}`);
}

console.log('\n=== 寻找 fetch hook ===');
const fetchRe = /\bfetch\b/g;
let fetchIdx = 0;
while ((m = fetchRe.exec(src)) !== null && fetchIdx < 5) {
  fetchIdx++;
  const ctx = src.slice(Math.max(0, m.index - 60), m.index + 150);
  console.log(`\n位置 ${m.index}:\n  ${ctx.replace(/\n/g, '\n  ')}`);
}
