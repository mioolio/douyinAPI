/* 深入分析 bdms.js 中间部分，寻找 JSVMP VM 和 a_bogus 生成逻辑 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'data', 'capture', 'bdms.js');
const src = fs.readFileSync(file, 'utf-8');

console.log('文件总长度:', src.length);

// 找出所有 webpack 模块及其大小
console.log('\n=== 1. 所有 webpack 模块及其大小 ===');
const mods = [];
const modRe = /(\d{2,5}):function\(t,r,e\)\{/g;
let m;
while ((m = modRe.exec(src)) !== null) {
  mods.push({ id: m[1], start: m.index });
}
for (let i = 0; i < mods.length; i++) {
  const end = i + 1 < mods.length ? mods[i + 1].start : src.length;
  mods[i].size = end - mods[i].start;
}
// 按大小排序
mods.sort((a, b) => b.size - a.size);
console.log('最大的 10 个模块:');
mods.slice(0, 10).forEach(x => {
  console.log(`  ID ${x.id} 大小=${x.size} 起始=${x.start}`);
});

console.log('\n=== 2. 最大模块的开头（前 2KB） ===');
if (mods.length > 0) {
  const big = mods[0];
  console.log(`模块 ${big.id} 大小 ${big.size} 字节`);
  console.log('内容前 2000 字符:');
  console.log(src.slice(big.start, big.start + 2000));
}

console.log('\n=== 3. 查找 "function" 关键字密度区域（可能是 VM 代码） ===');
// 用滑动窗口找 function 关键字密集区
const win = 5000;
let maxFnCount = 0;
let maxFnPos = 0;
for (let i = 0; i < src.length - win; i += win) {
  const sub = src.slice(i, i + win);
  const cnt = (sub.match(/function/g) || []).length;
  if (cnt > maxFnCount) {
    maxFnCount = cnt;
    maxFnPos = i;
  }
}
console.log(`最密集区域: pos=${maxFnPos}, function 关键字 ${maxFnCount} 次`);

console.log('\n=== 4. 查找各种 dispatcher 模式 ===');
// JSVMP 可能用 `for(;;)` `for(;1;)` `while(true)` `for(;;)` 等
const patterns = [
  { name: 'for(;;)', re: /for\s*\(\s*;;\s*\)/g },
  { name: 'while(true)', re: /while\s*\(\s*true\s*\)/g },
  { name: 'while(0==0)', re: /while\s*\(\s*0\s*==\s*0\s*\)/g },
  { name: 'switch(1)', re: /switch\s*\(\s*1\s*\)/g },
  { name: 'for(1;1;)', re: /for\s*\(\s*1\s*;\s*1\s*;/g },
  { name: 'for(true;true;)', re: /for\s*\(\s*true\s*;\s*true\s*;/g },
  { name: 'for(...;1!=0;)', re: /for\s*\([^;]{0,30};\s*1\s*!=\s*0\s*;/g },
  { name: 'while(t<r)', re: /while\s*\(\s*t\s*<\s*r\s*\)/g },
  { name: 'while(t<e)', re: /while\s*\(\s*t\s*<\s*e\s*\)/g },
  { name: 'while(1<2)', re: /while\s*\(\s*1\s*<\s*2\s*\)/g },
];
for (const p of patterns) {
  const matches = [];
  let pm;
  while ((pm = p.re.exec(src)) !== null) {
    matches.push(pm.index);
  }
  if (matches.length > 0) {
    console.log(`${p.name}: ${matches.length} 处 - pos=${matches.slice(0, 5).join(',')}`);
  }
}

console.log('\n=== 5. 查找长字符串字面量（可能是 base64 表或字节码字符串） ===');
// 字符串字面量，至少 30 字符（不含前缀）
const strRe = /"([^"\\]{30,})"|'([^'\\]{30,})'/g;
const longStrs = [];
while ((m = strRe.exec(src)) !== null) {
  const s = m[1] || m[2];
  longStrs.push({ s, pos: m.index });
}
console.log('长度>=30 的纯字符字符串:', longStrs.length);
// 按长度排序，前 20
longStrs.sort((a, b) => b.s.length - a.s.length);
longStrs.slice(0, 30).forEach(x => {
  // 显示字符集特征
  const has_alpha = /[a-z]/.test(x.s);
  const has_ALPHA = /[A-Z]/.test(x.s);
  const has_digit = /\d/.test(x.s);
  const has_special = /[^a-zA-Z0-9]/.test(x.s);
  const features = (has_alpha ? 'a' : '') + (has_ALPHA ? 'A' : '') + (has_digit ? '0' : '') + (has_special ? '!' : '');
  console.log(`  len=${x.s.length} pos=${x.pos} chars=[${features}] unique=${new Set(x.s).size}: ${x.s.slice(0, 80)}`);
});

console.log('\n=== 6. 查找 webmssdk / sdk-glue 引用 ===');
for (const kw of ['webmssdk', 'sdk-glue', 'sdk_glue', 'bd-ticket', 'a_bogus', 'msToken', 'verifyFp', 's_v_web_id']) {
  const idx = src.indexOf(kw);
  console.log(`  ${kw}: ${idx >= 0 ? `pos=${idx}` : '未找到'}`);
}
