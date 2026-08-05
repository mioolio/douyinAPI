/* 分析 bdms.js 结构：定位 a_bogus 生成入口 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'data', 'capture', 'bdms.js');
const src = fs.readFileSync(file, 'utf-8');

console.log(`文件大小: ${src.length} 字节\n`);

// 1. 开头部分 - 检查是否有大字符串数组
console.log('=== 开头 800 字节 ===');
console.log(src.slice(0, 800));
console.log('\n...\n');

// 2. 字符串解密函数模式
console.log('=== 寻找字符串解密函数（function X(idx) { return arr[idx - offset]; }） ===');
const decryptRe = /function\s+(\w+)\s*\(\s*(\w+)\s*(?:,\s*\w+\s*)?\)\s*\{\s*return\s+(\w+)\s*\[\s*\2\s*-\s*(\d+)\s*\]\s*\}/g;
let m;
while ((m = decryptRe.exec(src)) !== null) {
  console.log(`  解密函数: ${m[1]}(idx) => ${m[3]}[idx - ${m[4]}] (位置 ${m.index})`);
}

// 3. 寻找大字符串数组
console.log('\n=== 寻找大字符串数组（开头） ===');
const arrMatch = src.match(/(?:var|function\s+\w+|)\s*(\w+)\s*=\s*\[\s*"[^"]+"\s*(?:,\s*"[^"]+"\s*){10,}\s*\]/);
if (arrMatch) {
  console.log(`  数组变量名: ${arrMatch[1]}`);
  console.log(`  前 300 字节: ${arrMatch[0].slice(0, 300)}...`);
} else {
  console.log('  未找到（可能用更复杂的混淆）');
}

// 4. 寻找 D 函数（按文章描述，是导出入口）
console.log('\n=== 寻找 D 函数（D(t, r) { var e = z[t]; ...}） ===');
const dRe = /function\s+D\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*\{[\s\S]{0,300}?\}/g;
while ((m = dRe.exec(src)) !== null) {
  console.log(`  位置 ${m.index}: ${m[0].slice(0, 400)}`);
}

// 5. 寻找 z 数组（D 函数依赖）
console.log('\n=== 寻找 z = [...] 大数组定义 ===');
const zRe = /\bz\s*=\s*\[\s*([\s\S]{0,500}?)\]/g;
while ((m = zRe.exec(src)) !== null) {
  console.log(`  位置 ${m.index}: ${m[0].slice(0, 300)}`);
}

// 6. window.XX = 暴露
console.log('\n=== window.XX = ... 暴露 ===');
const winRe = /window\.(\w+)\s*=/g;
const exposed = new Set();
while ((m = winRe.exec(src)) !== null) {
  exposed.add(m[1]);
}
console.log([...exposed].sort().join(', '));

// 7. 函数定义统计
console.log('\n=== 函数定义统计 ===');
const fnDefCount = (src.match(/function\s+\w+\s*\(/g) || []).length;
const arrowFnCount = (src.match(/=>\s*[{(]/g) || []).length;
console.log(`function 定义: ${fnDefCount}`);
console.log(`箭头函数: ${arrowFnCount}`);

// 8. 寻找疑似 a_bogus 字符串字面量
console.log('\n=== 寻找 "a_bogus" 字符串字面量（可能混淆/拼接） ===');
const abRe = /["'`]a_bogus["'`]/g;
let abIdx = 0;
while ((m = abRe.exec(src)) !== null && abIdx < 3) {
  abIdx++;
  const ctx = src.slice(Math.max(0, m.index - 100), m.index + 100);
  console.log(`  位置 ${m.index}: ...${ctx}...`);
}

// 9. 寻找 apply + arguments 调用模式
console.log('\n=== 寻找 .apply(this, arguments) 模式 ===');
const applyRe = /\.apply\s*\(\s*this\s*,\s*arguments\s*\)/g;
let applyIdx = 0;
while ((m = applyRe.exec(src)) !== null && applyIdx < 5) {
  applyIdx++;
  const ctx = src.slice(Math.max(0, m.index - 200), m.index + 50);
  console.log(`\n位置 ${m.index}:\n  ${ctx.slice(-250).replace(/\n/g, '\n  ')}`);
}

// 10. 寻找 XMLHttpRequest hook（关键路径）
console.log('\n=== XMLHttpRequest hook ===');
const xhrRe = /XMLHttpRequest/g;
let xhrIdx = 0;
while ((m = xhrRe.exec(src)) !== null && xhrIdx < 3) {
  xhrIdx++;
  const ctx = src.slice(Math.max(0, m.index - 100), m.index + 300);
  console.log(`\n位置 ${m.index}:\n  ${ctx.replace(/\n/g, '\n  ')}`);
}

// 11. 寻找 navigator 引用
console.log('\n=== navigator 引用 ===');
const navRe = /\bnavigator\b/g;
let navIdx = 0;
while ((m = navRe.exec(src)) !== null && navIdx < 3) {
  navIdx++;
  const ctx = src.slice(Math.max(0, m.index - 60), m.index + 150);
  console.log(`\n位置 ${m.index}:\n  ${ctx.replace(/\n/g, '\n  ')}`);
}
