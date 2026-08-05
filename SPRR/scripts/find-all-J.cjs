/* 找出所有名为 J 的函数定义和它们的作用域 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'data', 'capture', 'bdms.js');
const src = fs.readFileSync(file, 'utf-8');

console.log('=== 1. 所有 "function J(" 定义 ===');
const jDefRe = /function\s+J\s*\(/g;
let m;
while ((m = jDefRe.exec(src)) !== null) {
  console.log(`\n  pos=${m.index}`);
  // 输出后 1500 字符
  console.log(src.slice(m.index, m.index + 1500));
  console.log('---');
}

console.log('\n=== 2. 所有 "var J=" / "J=function" 定义 ===');
const jVarRe = /\bJ\s*=\s*function/g;
while ((m = jVarRe.exec(src)) !== null) {
  console.log(`\n  pos=${m.index}`);
  console.log(src.slice(m.index, m.index + 800));
  console.log('---');
}

console.log('\n=== 3. J(232,...) 调用所在的上下文（前 2KB） ===');
const callPos = src.indexOf('J(232');
console.log(`J(232) 位置: ${callPos}`);
console.log(src.slice(Math.max(0, callPos - 2000), callPos + 500));

console.log('\n=== 4. J(232,...) 之前最近的 function 定义 ===');
// 反向查找 function 关键字
let searchPos = callPos;
let lastFunc = -1;
while (searchPos > 0) {
  searchPos = src.lastIndexOf('function', searchPos - 1);
  if (searchPos < 0) break;
  // 看这个 function 是不是定义一个 J
  const after = src.slice(searchPos, searchPos + 30);
  if (/^function\s+J\s*\(/.test(after) || /^function\s*\(/.test(after)) {
    lastFunc = searchPos;
    console.log(`  最近 function @ pos=${searchPos}: ${src.slice(searchPos, searchPos + 80)}`);
    break;
  }
}
