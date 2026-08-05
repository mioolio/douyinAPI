/* 在 bdms.js 中查找 JSVMP VM 的字节码数组 o 和字符串常量表 Z 的初始化 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'data', 'capture', 'bdms.js');
const src = fs.readFileSync(file, 'utf-8');

console.log('=== 1. 查找 Z 字符串常量表的初始化 ===');
// Z 通常通过 `Z=[...]` 或 `var Z=...` 或 `Z=` 形式初始化
const zRe = /\bZ\s*=\s*[^;]{1,200}/g;
let m;
const zMatches = [];
while ((m = zRe.exec(src)) !== null) {
  zMatches.push({ pos: m.index, ctx: src.slice(m.index, m.index + 200) });
}
console.log(`Z= 出现次数: ${zMatches.length}`);
zMatches.slice(0, 10).forEach((x, i) => {
  console.log(`\n  [${i}] pos=${x.pos}`);
  console.log(`  ${x.ctx.slice(0, 200)}`);
});

console.log('\n=== 2. 查找字节码数组 o 的初始化（o=[数字,...]） ===');
// o 通常是大数字数组
const oRe = /\bo\s*=\s*\[(\d+(?:,\d+){50,})\]/g;
const oMatches = [];
while ((m = oRe.exec(src)) !== null) {
  const arr = m[1].split(',').map(Number);
  oMatches.push({ pos: m.index, arr });
}
console.log(`o=[大数字数组] 出现次数: ${oMatches.length}`);
oMatches.slice(0, 5).forEach((x, i) => {
  console.log(`  [${i}] pos=${x.pos} 长度=${x.arr.length} 范围=${Math.min(...x.arr)}..${Math.max(...x.arr)}`);
  console.log(`  前 50: ${x.arr.slice(0, 50).join(',')}`);
});

console.log('\n=== 3. 查找 z 数组初始化（z=[函数1, 函数2, ...]） ===');
// 在 bdms.js 中看到 `function D(t,r){var e=z[t];` - z 是函数表
// 通常 z 的初始化是 z=[function(t,r,e){...},function(t,r,e){...},...]
const zInitRe = /\bz\s*=\s*\[/g;
const zInitMatches = [];
while ((m = zInitRe.exec(src)) !== null) {
  zInitMatches.push({ pos: m.index, ctx: src.slice(m.index, m.index + 500) });
}
console.log(`z=[ 出现次数: ${zInitMatches.length}`);
zInitMatches.slice(0, 3).forEach((x, i) => {
  console.log(`\n  [${i}] pos=${x.pos}`);
  console.log(`  ${x.ctx.slice(0, 400)}`);
});

console.log('\n=== 4. 查找 var o / var v / var Z / var s / var c 等 VM 变量声明 ===');
const varDecls = ['o', 'v', 'Z', 's', 'c', 'p', 'a', 'f', 'l', 'h', 'i', 'u'];
for (const v of varDecls) {
  // 查找 `var X` 或 `,X=` 形式（在 VM 区域内）
  const re = new RegExp(`\\bvar\\s+${v}\\b|,${v}=`, 'g');
  const matches = [];
  while ((m = re.exec(src)) !== null) {
    if (m.index > 130000 && m.index < 147523) {
      matches.push({ pos: m.index, ctx: src.slice(m.index, m.index + 80) });
    }
  }
  if (matches.length > 0) {
    console.log(`\n${v}: ${matches.length} 处（在 VM 区域内）`);
    matches.slice(0, 3).forEach(x => console.log(`  pos=${x.pos}: ${x.ctx.replace(/\n/g, '\\n')}`));
  }
}

console.log('\n=== 5. 查找 VM 函数定义 ===');
// VM 函数通常是 `function d(){for(;;){...}}` 形式
// 或 `var X=function(){for(;;){...}}` 形式
const vmFuncRe = /(\w+)\s*=\s*function\s*\w*\s*\(\)\s*\{\s*for\s*\(\s*;;\s*\)/g;
const vmFuncMatches = [];
while ((m = vmFuncRe.exec(src)) !== null) {
  vmFuncMatches.push({ name: m[1], pos: m.index });
}
console.log(`X=function(){for(;;)}: ${vmFuncMatches.length}`);
vmFuncMatches.forEach(x => console.log(`  ${x.name} @ pos=${x.pos}`));

// 也查找 `function d(){for(;;)` 形式
const vmFuncRe2 = /function\s+(\w+)\s*\(\)\s*\{\s*for\s*\(\s*;;\s*\)/g;
const vmFuncMatches2 = [];
while ((m = vmFuncRe2.exec(src)) !== null) {
  vmFuncMatches2.push({ name: m[1], pos: m.index });
}
console.log(`function X(){for(;;)}: ${vmFuncMatches2.length}`);
vmFuncMatches2.forEach(x => console.log(`  ${x.name} @ pos=${x.pos}`));

console.log('\n=== 6. 查找 VM 入口函数 D / X 等 ===');
// 在 dispatcher 中看到 `function D(t,r){var e=z[t];` 和 `function X(e,t,r,n)`
// D 是注册函数，X 是执行函数
const dPos = src.indexOf('function D(t,r){var e=z[t];');
const xPos = src.indexOf('function X(');
console.log(`function D(t,r) 位置: ${dPos}`);
console.log(`function X( 位置: ${xPos}`);

if (xPos >= 0) {
  console.log('\n=== 7. function X 上下文 ===');
  console.log(src.slice(xPos, xPos + 1500));
}

// 查找 `g(y[0],d,e,y[1])` - 这是 VM 调用入口
console.log('\n=== 8. 查找 VM 调用入口 g() ===');
const gCallsRe = /\bg\s*\(\s*\w+\[[^\]]+\]\s*,/g;
const gCalls = [];
while ((m = gCallsRe.exec(src)) !== null) {
  gCalls.push({ pos: m.index, ctx: src.slice(m.index, m.index + 100) });
}
console.log(`g(x[..],..) 调用: ${gCalls.length}`);
gCalls.slice(0, 5).forEach((x, i) => {
  console.log(`  [${i}] pos=${x.pos}: ${x.ctx.slice(0, 100)}`);
});
