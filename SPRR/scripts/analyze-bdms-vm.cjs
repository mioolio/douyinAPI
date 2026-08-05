/* 分析 bdms.js 中的 JSVMP VM 区域，找到字节码和常量池 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'data', 'capture', 'bdms.js');
const src = fs.readFileSync(file, 'utf-8');

// 从 pos=130000 开始的 VM dispatcher 区域
const VM_START = 130000;
const VM_END = 147523;

console.log('=== 1. JSVMP VM dispatcher 区域 ===');
const vmCode = src.slice(VM_START, VM_END);
console.log('VM 代码长度:', vmCode.length);

// 找到 `for(;;)` 的位置
const forEver = vmCode.indexOf('for(;;)');
console.log('for(;;) 相对位置:', forEver, '绝对位置:', VM_START + forEver);

// 输出 for(;;) 之后的代码（这是 dispatcher）
console.log('\n=== 2. for(;;) dispatcher 上下文（前 300 + 后 2000） ===');
const dispStart = forEver - 300;
const dispEnd = forEver + 2000;
console.log(vmCode.slice(dispStart, dispEnd));

console.log('\n=== 3. 查找所有长字符串（含数字和大写字母，可能是字节码） ===');
// 在 VM 区域内查找所有字符串字面量
const strRe = /"([^"\\]{4,500})"|'([^'\\]{4,500})'/g;
const strs = [];
let m;
while ((m = strRe.exec(vmCode)) !== null) {
  const s = m[1] || m[2];
  strs.push({ s, pos: VM_START + m.index });
}
console.log(`VM 区域内 4+ 字符字符串: ${strs.length}`);
strs.sort((a, b) => b.s.length - a.s.length);
console.log('前 30 个最长字符串:');
strs.slice(0, 30).forEach((x, i) => {
  const unique = new Set(x.s).size;
  const isAscii = /^[\x20-\x7E]+$/.test(x.s);
  const isPrintable = /^[\x20-\x7E]+$/.test(x.s);
  console.log(`  [${i}] pos=${x.pos} len=${x.s.length} unique=${unique} ${isPrintable ? '可打印' : '非ASCII'}: ${JSON.stringify(x.s.slice(0, 100))}${x.s.length > 100 ? '...' : ''}`);
});

console.log('\n=== 4. 查找所有 4 字符字符串（可能是盐值 dhzx 等） ===');
const shortStrs = strs.filter(x => x.s.length === 4);
console.log(`4 字符字符串: ${shortStrs.length}`);
shortStrs.forEach((x, i) => {
  console.log(`  [${i}] pos=${x.pos}: ${JSON.stringify(x.s)}`);
});

console.log('\n=== 5. 查找所有 64 字符字符串（可能是 base64 表） ===');
const b64Strs = strs.filter(x => x.s.length === 64);
console.log(`64 字符字符串: ${b64Strs.length}`);
b64Strs.forEach((x, i) => {
  console.log(`  [${i}] pos=${x.pos}: ${x.s}`);
});

console.log('\n=== 6. 查找所有以 "L" 或大写字母开头的 32 字符字符串（可能是 hash 表） ===');
const hash32 = strs.filter(x => x.s.length === 32);
console.log(`32 字符字符串: ${hash32.length}`);
hash32.forEach((x, i) => {
  console.log(`  [${i}] pos=${x.pos}: ${x.s}`);
});

console.log('\n=== 7. 查找单字节字符串数组（可能是字节码常量池） ===');
// 形式 `["abc","def","ghi",...]`
const arrStrRe = /\[((?:"[^"\\]{0,5}",){20,})\]/g;
const arrStrs = [];
while ((m = arrStrRe.exec(vmCode)) !== null) {
  const arr = m[1].slice(0, -1).split('","').map(s => s.replace(/^"|"$/g, ''));
  arrStrs.push({ arr, pos: VM_START + m.index });
}
console.log(`字符串数组（>=20 元素）: ${arrStrs.length}`);
arrStrs.slice(0, 5).forEach((x, i) => {
  console.log(`  [${i}] pos=${x.pos} 长度=${x.arr.length}`);
  console.log(`     前 30: ${JSON.stringify(x.arr.slice(0, 30))}`);
});

console.log('\n=== 8. 查找数字数组（可能是字节码本体） ===');
// 形式 `[数字,数字,...]`
const numArrRe = /\[((?:\d{1,4},){30,}\d{1,4})\]/g;
const numArrs = [];
while ((m = numArrRe.exec(vmCode)) !== null) {
  const arr = m[1].split(',').map(Number);
  numArrs.push({ arr, pos: VM_START + m.index });
}
console.log(`数字数组（>=31 元素）: ${numArrs.length}`);
numArrs.sort((a, b) => b.arr.length - a.arr.length);
numArrs.slice(0, 5).forEach((x, i) => {
  console.log(`  [${i}] pos=${x.pos} 长度=${x.arr.length} 范围=${Math.min(...x.arr)}..${Math.max(...x.arr)}`);
  console.log(`     前 50: ${x.arr.slice(0, 50).join(',')}`);
});
