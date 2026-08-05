/* 深入分析 bdms.js：从 SM3 实现位置反向追踪 a_bogus 生成入口 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'data', 'capture', 'bdms.js');
const src = fs.readFileSync(file, 'utf-8');

console.log('=== 1. SM3 模块周围的代码（前后 5KB） ===');
const sm3Idx = src.indexOf('1937774191');
console.log('SM3 IV 位置:', sm3Idx);

// 找到包含 SM3 IV 的 webpack 模块边界
// 模块边界是 `\d{2,5}:function(t,r,e){`
let start = src.lastIndexOf('function(t,r,e){', sm3Idx);
start = src.lastIndexOf(',', start);
let modStart = src.lastIndexOf('{', start);
// 再往前找模块 ID
let idEnd = src.lastIndexOf(':', modStart);
let idStart = idEnd - 1;
while (idStart > 0 && /\d/.test(src[idStart - 1])) idStart--;
const modId = src.slice(idStart, idEnd);
console.log('SM3 所在模块 ID:', modId);

// 找模块的结尾（粗略）：下一个 `,\d{2,5}:function`
const nextModRe = /,(\d{2,5}):function\(t,r,e\)\{/g;
nextModRe.lastIndex = sm3Idx;
const nextM = nextModRe.exec(src);
const modEnd = nextM ? nextM.index : src.length;
console.log('模块结束位置:', modEnd, '模块大小:', modEnd - idStart);

// 输出该模块的全部内容
const modContent = src.slice(idStart, modEnd);
console.log('\n=== 2. SM3 模块内容（前 5KB） ===');
console.log(modContent.slice(0, 5000));

console.log('\n=== 3. 模块导出（module.exports） ===');
const exportRe = /t\.exports\s*=\s*[^;]+;/g;
let em;
let exportsFound = [];
while ((em = exportRe.exec(modContent)) !== null) {
  exportsFound.push(em[0]);
}
console.log('exports 数量:', exportsFound.length);
exportsFound.slice(0, 5).forEach(x => console.log('  ', x.slice(0, 200)));

console.log('\n=== 4. 查找 RC4 特征 ===');
// RC4 关键特征：S-box 初始化 [0..255] 或 [255..0]
// 反转 S-box: for(i=0;i<256;i++) S[i]=255-i 或 S[255-i]=i
const rc4Re1 = /for\s*\(\s*\w+\s*=\s*0\s*;\s*\w+\s*<\s*256/g;
const rc4Matches1 = [];
let rc;
while ((rc = rc4Re1.exec(src)) !== null) {
  rc4Matches1.push({ pos: rc.index, ctx: src.slice(rc.index, rc.index + 200) });
}
console.log('for(...<256) 循环:', rc4Matches1.length);
rc4Matches1.slice(0, 5).forEach((x, i) => {
  console.log(`\n  [${i}] pos=${x.pos}`);
  console.log('  ctx:', x.ctx.replace(/\n/g, '\\n'));
});

console.log('\n=== 5. 查找 base64 编码特征 ===');
// base64 通常有 `<<2` `>>4` `&3` `<<4` `>>2` `&15` `<<6` `>>6` 这些位运算
const b64Re = /<<2|>>4|&3\b|<<4|>>2|&15\b|<<6|>>6/g;
const b64Matches = [];
let bm;
while ((bm = b64Re.exec(src)) !== null) {
  b64Matches.push(bm.index);
}
console.log('base64 位运算出现次数:', b64Matches.length);

// 检查是否有从某字符串中查找索引的操作（即查表）
const tableLookupRe = /(\w+)\.indexOf\(([^)]{1,30})\)/g;
const tableLookups = [];
while ((bm = tableLookupRe.exec(src)) !== null) {
  tableLookups.push({ var: bm[1], arg: bm[2], pos: bm.index });
}
console.log('变量.indexOf() 调用:', tableLookups.length);
// 找出调用最多的变量
const varCounts = {};
for (const x of tableLookups) {
  varCounts[x.var] = (varCounts[x.var] || 0) + 1;
}
const topVars = Object.entries(varCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
console.log('最常被 indexOf 的变量:');
topVars.forEach(([v, c]) => console.log(`  ${v}: ${c} 次`));

console.log('\n=== 6. 查找 charCodeAt + 字符串模式（base64 查表） ===');
const charAtRe = /(\w+)\.charCodeAt\((\w+)\)/g;
const charAtCalls = [];
while ((bm = charAtRe.exec(src)) !== null) {
  charAtCalls.push({ var: bm[1], arg: bm[2], pos: bm.index });
}
console.log('变量.charCodeAt(n) 调用:', charAtCalls.length);
const charVarCounts = {};
for (const x of charAtCalls) {
  charVarCounts[x.var] = (charVarCounts[x.var] || 0) + 1;
}
const topCharVars = Object.entries(charVarCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
console.log('最常被 charCodeAt 的变量:');
topCharVars.forEach(([v, c]) => console.log(`  ${v}: ${c} 次`));

console.log('\n=== 7. 浏览器蜜罐检测（pemrissions / __proto__） ===');
const honeypots = ['pemrissions', 'grnated', 'onwheelx', '_Ax'];
for (const h of honeypots) {
  const idx = src.indexOf(h);
  console.log(`  ${h}: ${idx >= 0 ? `pos=${idx}` : '未找到'}`);
}

console.log('\n=== 8. 查找 `atob` `btoa` 调用 ===');
const atobCount = (src.match(/\batob\b/g) || []).length;
const btoaCount = (src.match(/\bbtoa\b/g) || []).length;
console.log(`  atob: ${atobCount} 次, btoa: ${btoaCount} 次`);

console.log('\n=== 9. 查找 "navigator." 字符串引用 ===');
const navMatches = src.match(/navigator\.\w+/g) || [];
const navCounts = {};
navMatches.forEach(x => navCounts[x] = (navCounts[x] || 0) + 1);
console.log('navigator.* 引用:');
Object.entries(navCounts).sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
