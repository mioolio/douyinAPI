/* 查找 bdms.js 中所有 J(...) 调用，提取 base64 编码的字节码字符串 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'data', 'capture', 'bdms.js');
const src = fs.readFileSync(file, 'utf-8');

console.log('=== 1. 查找 J( 调用（VM 字节码加载） ===');
// J 调用形式： J("base64...", arg1, arg2, arg3)
const jRe = /\bJ\s*\(\s*"([A-Za-z0-9+/=]{50,})"\s*,/g;
const jCalls = [];
let m;
while ((m = jRe.exec(src)) !== null) {
  jCalls.push({ b64: m[1], pos: m.index });
}
console.log(`J("base64") 调用: ${jCalls.length}`);
jCalls.sort((a, b) => b.b64.length - a.b64.length);
jCalls.slice(0, 10).forEach((x, i) => {
  console.log(`  [${i}] pos=${x.pos} b64长度=${x.b64.length}`);
  console.log(`     b64前80: ${x.b64.slice(0, 80)}`);
  console.log(`     b64后80: ${x.b64.slice(-80)}`);
  // 尝试解码
  try {
    const decoded = Buffer.from(x.b64, 'base64');
    console.log(`     解码长度=${decoded.length} 字节`);
    console.log(`     解码前 16 字节 hex: ${[...decoded.slice(0, 16)].map(b=>b.toString(16).padStart(2,'0')).join(' ')}`);
    console.log(`     解码前 32 字节 printable: ${[...decoded.slice(0, 32)].map(b=>b>=32&&b<127?String.fromCharCode(b):'.').join('')}`);
  } catch (e) {
    console.log(`     解码失败: ${e.message}`);
  }
});

// 也查找单引号形式
const jRe2 = /\bJ\s*\(\s*'([A-Za-z0-9+/=]{50,})'\s*,/g;
while ((m = jRe2.exec(src)) !== null) {
  jCalls.push({ b64: m[1], pos: m.index, quote: "'" });
}
console.log(`\n含单引号形式: 总共 ${jCalls.length}`);

console.log('\n=== 2. 查找所有 J() 调用的参数（包括非字符串） ===');
const jRe3 = /\bJ\s*\(\s*([^,)]{1,200})\s*,\s*([^,)]{1,200})\s*,\s*([^,)]{1,200})\s*,\s*([^,)]{1,200})\s*\)/g;
const jAllCalls = [];
while ((m = jRe3.exec(src)) !== null) {
  jAllCalls.push({ args: [m[1], m[2], m[3], m[4]], pos: m.index });
}
console.log(`J(a,b,c,d) 调用: ${jAllCalls.length}`);
jAllCalls.slice(0, 30).forEach((x, i) => {
  console.log(`  [${i}] pos=${x.pos}: J(${x.args.map(a=>a.slice(0,40)).join(', ')})`);
});

console.log('\n=== 3. 查找 atob(...) 调用 ===');
const atobRe = /\batob\s*\(\s*"([A-Za-z0-9+/=]{50,})"\s*\)/g;
const atobCalls = [];
while ((m = atobRe.exec(src)) !== null) {
  atobCalls.push({ b64: m[1], pos: m.index });
}
console.log(`atob("base64") 调用: ${atobCalls.length}`);
atobCalls.sort((a, b) => b.b64.length - a.b64.length);
atobCalls.slice(0, 5).forEach((x, i) => {
  console.log(`  [${i}] pos=${x.pos} b64长度=${x.b64.length}`);
});

console.log('\n=== 4. 查找 SDK 初始化入口 init ===');
// 在 bdms.js 中查找 init / sdk_init / signature / sign 等关键字
for (const kw of ['init', 'sign', 'signature', 'a_bogus', 'msToken', 'X-Bogus', 'Bogus', 'signUrl', 'signRequest', 'generateSignature']) {
  const re = new RegExp(`\\b${kw}\\b`, 'g');
  const matches = [];
  while ((m = re.exec(src)) !== null) {
    matches.push(m.index);
  }
  if (matches.length > 0) {
    console.log(`  ${kw}: ${matches.length} 处 - pos=${matches.slice(0, 5).join(',')}`);
  }
}

console.log('\n=== 5. 查找 window.bdms 赋值 ===');
const bdmsAssignRe = /window\.bdms\s*=\s*[^;]{1,200};/g;
while ((m = bdmsAssignRe.exec(src)) !== null) {
  console.log(`  pos=${m.index}: ${m[0].slice(0, 200)}`);
}

console.log('\n=== 6. 查找 init 函数定义 ===');
const initRe = /init\s*:\s*function\s*\([^)]*\)\s*\{/g;
while ((m = initRe.exec(src)) !== null) {
  console.log(`  pos=${m.index}: ${src.slice(m.index, m.index + 200)}`);
}

console.log('\n=== 7. 查找 hook XMLHttpRequest.open/send ===');
const hookRe = /XMLHttpRequest\.prototype\.(open|send|setRequestHeader)\s*=/g;
while ((m = hookRe.exec(src)) !== null) {
  console.log(`  pos=${m.index}: ${src.slice(m.index, m.index + 200).slice(0, 150)}`);
}
