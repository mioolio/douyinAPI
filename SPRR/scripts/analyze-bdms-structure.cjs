/* 分析 bdms.js 的 webpack 模块结构，找出 JSVMP VM 模块 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'data', 'capture', 'bdms.js');
const src = fs.readFileSync(file, 'utf-8');

console.log('=== 1. 文件版本和入口 ===');
const verMatch = src.match(/\/\*\s*V\s*([\d.\-fix]+)\s*\*\//);
console.log('版本:', verMatch ? verMatch[1] : '未知');

console.log('\n=== 2. webpack 模块定义 ===');
// 匹配 `\d{2,5}:function(t,r,e){` 形式
const modIds = [];
const modRe = /(\d{2,5}):function\(t,r,e\)\{/g;
let m;
while ((m = modRe.exec(src)) !== null) {
  modIds.push({ id: m[1], pos: m.index });
}
console.log('模块总数:', modIds.length);
console.log('前 10 个模块 ID:', modIds.slice(0, 10).map(x => x.id).join(', '));

console.log('\n=== 3. 查找 JSVMP VM 模块特征 ===');
// JSVMP VM 通常有大的数组作为字节码，以及一个 dispatcher 函数
// 常见特征：`while(1){switch(...)` 或 `while(t<r){case` 或大数字数组
const jsvmpRe = /while\s*\(\s*(?:1|true)\s*\)\s*\{[^}]{0,200}switch/gi;
const jsvmpMatches = [];
const re1 = /while\s*\(\s*(?:1|true)\s*\)/g;
while ((m = re1.exec(src)) !== null) {
  jsvmpMatches.push({ pos: m.index, ctx: src.slice(m.index, m.index + 200) });
}
console.log('while(1) 出现次数:', jsvmpMatches.length);
jsvmpMatches.slice(0, 3).forEach((x, i) => {
  console.log(`\n  [${i}] pos=${x.pos}`);
  console.log('  ctx:', x.ctx.replace(/\n/g, '\\n').slice(0, 150));
});

console.log('\n=== 4. 查找字符串表（字符串数组） ===');
// 查找 `var X = ["...", "...", ...]` 形式
const strArrRe = /var\s+(\w+)\s*=\s*\[(?:"[^"]{0,30}",){10,}\]/g;
const strArrs = [];
while ((m = strArrRe.exec(src)) !== null) {
  // 计算这个数组有多少元素
  const arrEnd = src.indexOf(']', m.index);
  if (arrEnd > 0) {
    const arrContent = src.slice(m.index, arrEnd + 1);
    const count = (arrContent.match(/"/g) || []).length / 2;
    strArrs.push({ name: m[1], pos: m.index, count });
  }
}
console.log('字符串数组（>=10 元素）:', strArrs.length);
strArrs.slice(0, 10).forEach(x => {
  console.log(`  ${x.name} @ pos=${x.pos} 约 ${x.count} 字符串`);
});

console.log('\n=== 5. 查找 hex 字符串（可能编码的字节码） ===');
const hexRe = /["']([0-9a-fA-F]{32,})["']/g;
const hexStrs = [];
while ((m = hexRe.exec(src)) !== null) {
  hexStrs.push({ str: m[1], pos: m.index });
}
console.log('32+ 字符 hex 字符串:', hexStrs.length);
hexStrs.slice(0, 5).forEach(x => {
  console.log(`  pos=${x.pos} 长度=${x.str.length}: ${x.str.slice(0, 64)}...`);
});

console.log('\n=== 6. 查找大数字常量（可能是字节码） ===');
// 查找 "1234567890123" 这种大数字
const bigNumRe = /(\d{12,})/g;
const bigNums = [];
while ((m = bigNumRe.exec(src)) !== null) {
  bigNums.push({ num: m[1], pos: m.index });
}
console.log('12+ 位数字:', bigNums.length);
// 这些数字可能就是时间戳，过滤一下
const uniqueBigNums = [...new Set(bigNums.map(x => x.num))];
console.log('独特值数量:', uniqueBigNums.length);
uniqueBigNums.slice(0, 10).forEach(n => console.log('  ', n));

console.log('\n=== 7. 查找 `navigator.pemrissions` 蜜罐特征 ===');
const honeypot = src.indexOf('pemrissions');
console.log('pemrissions 位置:', honeypot);
if (honeypot >= 0) {
  console.log('上下文:', src.slice(Math.max(0, honeypot - 100), honeypot + 100));
}

console.log('\n=== 8. 查找 `bdmsInvokeList` ===');
const invList = src.indexOf('bdmsInvokeList');
console.log('位置:', invList);
if (invList >= 0) {
  console.log('上下文:', src.slice(Math.max(0, invList - 100), invList + 200));
}

console.log('\n=== 9. 查找 `throw l` 阻塞 ===');
const throwMatches = [];
const reThrow = /throw\s+[a-z]\b/g;
while ((m = reThrow.exec(src)) !== null) {
  throwMatches.push({ match: m[0], pos: m.index });
}
console.log('throw <var> 总数:', throwMatches.length);
throwMatches.slice(0, 10).forEach(x => {
  console.log(`  pos=${x.pos}: ${src.slice(Math.max(0, x.pos - 60), x.pos + 40).replace(/\n/g, '\\n')}`);
});
