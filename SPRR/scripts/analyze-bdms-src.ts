/**
 * 分析 bdms.js 源码，定位 a_bogus 生成入口
 */
import { readFileSync } from 'fs';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('analyze-bdms-src');

const src = readFileSync('d:/Desktop/DYCC/SPRR/data/capture/bdms.js', 'utf-8');

log.info(`bdms.js 总长度: ${src.length} 字符`);

// 1. 找关键的字符串和模式
const patterns: Array<{ name: string; re: RegExp }> = [
  { name: 'a_bogus 字符串', re: /a_bogus/g },
  { name: 'aByss/Abogus', re: /[aA]byss[a-zA-Z_]*/g },
  { name: 'X-Bogus 字符串', re: /X-Bogus/g },
  { name: 'setRequestHeader', re: /setRequestHeader/g },
  { name: 'XMLHttpRequest', re: /XMLHttpRequest/g },
  { name: 'XHR', re: /\bXHR\b/g },
  { name: 'dhzx 盐值', re: /dhzx/g },
  { name: 'borderlessXHR/bdmsXHR', re: /borderlessXHR|bdmsXHR|sdkxhr|new\s+XHR/g },
  { name: 'navigator.userAgent', re: /navigator\s*\[?\s*[\'"]?userAgent/g },
  { name: 'outerWidth', re: /outerWidth/g },
  { name: 'screen', re: /\bscreen\b/g },
  { name: 'window.outer', re: /window\[['"]?outer/g },
  { name: 'bdms 函数', re: /\bbdms\b/g },
  { name: 's3 table', re: /ckdp1h4Z/g },
  { name: 's4 table', re: /Dkdpgh2Z/g },
  { name: 'SM3 初始 IV', re: /0x7380166f|7380166f/g },
  { name: 'String.fromCharCode', re: /String\.fromCharCode/g },
  { name: 'parseInt(.*16)', re: /parseInt\([^)]+,\s*16/g },
  { name: 'Math.random', re: /Math\.random/g },
  { name: 'Date.now', re: /Date\.now/g },
  { name: 'init function', re: /['"]init['"]\s*:\s*function|function\s+_0x[a-f0-9]+\([^)]*\)\s*\{[^}]*init/g },
  { name: 'frontierSign function', re: /function\s+_0x[a-f0-9]+\([^)]*\)\s*\{[^}]*frontierSign/g },
  { name: 'sign function', re: /function\s+sign|function\s+_sign/g },
];

for (const p of patterns) {
  const matches = src.match(p.re) || [];
  log.info(`${p.name}: ${matches.length} 次`);
  if (matches.length > 0 && matches.length < 5) {
    log.info(`  示例: ${matches.slice(0, 5).join(', ')}`);
  }
}

// 2. 找 navigator.userAgent 的位置（用于了解如何访问 UA）
const uaIdx = src.indexOf('userAgent');
if (uaIdx >= 0) {
  log.info(`\n=== userAgent 上下文 (位置 ${uaIdx}) ===`);
  log.info(src.substring(Math.max(0, uaIdx - 200), uaIdx + 200));
}

// 3. 找 outerWidth 的位置
const outerIdx = src.indexOf('outerWidth');
if (outerIdx >= 0) {
  log.info(`\n=== outerWidth 上下文 (位置 ${outerIdx}) ===`);
  log.info(src.substring(Math.max(0, outerIdx - 200), outerIdx + 200));
}

// 4. 找 navigator 引用
const navIdx = src.indexOf('navigator');
if (navIdx >= 0) {
  log.info(`\n=== navigator 上下文 (位置 ${navIdx}) ===`);
  log.info(src.substring(Math.max(0, navIdx - 100), navIdx + 300));
}

// 5. 找 dhzx 盐值
const saltIdx = src.indexOf('dhzx');
if (saltIdx >= 0) {
  log.info(`\n=== 'dhzx' 盐值上下文 (位置 ${saltIdx}) ===`);
  log.info(src.substring(Math.max(0, saltIdx - 200), saltIdx + 200));
}

// 6. 找 'a_bogus' 字符串
const abIdx = src.indexOf('a_bogus');
if (abIdx >= 0) {
  log.info(`\n=== 'a_bogus' 上下文 (位置 ${abIdx}) ===`);
  log.info(src.substring(Math.max(0, abIdx - 300), abIdx + 300));
} else {
  log.info(`\n'bdms.js' 中没有 'a_bogus' 字符串`);
  log.info(`  a_bogus 是通过其他方式添加的（可能通过 XHR hook 注入）`);
}

// 7. 找 s3/s4 Base64 表
const s3Idx = src.indexOf('ckdp1h4Z');
const s4Idx = src.indexOf('Dkdpgh2Z');
log.info(`\ns3 表位置: ${s3Idx}`);
log.info(`s4 表位置: ${s4Idx}`);

if (s3Idx >= 0) {
  log.info(`\n=== s3 表上下文 (位置 ${s3Idx}) ===`);
  log.info(src.substring(Math.max(0, s3Idx - 100), s3Idx + 200));
}

if (s4Idx >= 0) {
  log.info(`\n=== s4 表上下文 (位置 ${s4Idx}) ===`);
  log.info(src.substring(Math.max(0, s4Idx - 100), s4Idx + 200));
}

// 8. 找 init / frontierSign 字符串
const initStr = src.indexOf('init');
const fsStr = src.indexOf('frontierSign');
log.info(`\n'init' 位置: ${initStr}`);
log.info(`'frontierSign' 位置: ${fsStr}`);

// 9. 找 'msToken' 字符串
const msTokenIdx = src.indexOf('msToken');
if (msTokenIdx >= 0) {
  log.info(`\n=== 'msToken' 上下文 (位置 ${msTokenIdx}) ===`);
  log.info(src.substring(Math.max(0, msTokenIdx - 200), msTokenIdx + 200));
}

// 10. 找 'verifyFp' 字符串
const verifyFpIdx = src.indexOf('verifyFp');
if (verifyFpIdx >= 0) {
  log.info(`\n=== 'verifyFp' 上下文 (位置 ${verifyFpIdx}) ===`);
  log.info(src.substring(Math.max(0, verifyFpIdx - 200), verifyFpIdx + 200));
}

// 11. 找 'webid' 字符串
const webidIdx = src.indexOf('webid');
if (webidIdx >= 0) {
  log.info(`\n=== 'webid' 上下文 (位置 ${webidIdx}) ===`);
  log.info(src.substring(Math.max(0, webidIdx - 200), webidIdx + 200));
}

// 12. 找 'X-Bogus' 字符串
const xBogusIdx = src.indexOf('X-Bogus');
if (xBogusIdx >= 0) {
  log.info(`\n=== 'X-Bogus' 上下文 (位置 ${xBogusIdx}) ===`);
  log.info(src.substring(Math.max(0, xBogusIdx - 200), xBogusIdx + 200));
}

// 13. 找 Math.random 的位置
const randomIdx = src.indexOf('Math.random');
if (randomIdx >= 0) {
  log.info(`\n=== 'Math.random' 上下文 (位置 ${randomIdx}) ===`);
  log.info(src.substring(Math.max(0, randomIdx - 200), randomIdx + 200));
}

// 14. 找 Date.now 的位置
const dateNowIdx = src.indexOf('Date.now');
if (dateNowIdx >= 0) {
  log.info(`\n=== 'Date.now' 上下文 (位置 ${dateNowIdx}) ===`);
  log.info(src.substring(Math.max(0, dateNowIdx - 200), dateNowIdx + 200));
}

// 15. 找 setRequestHeader 的位置
const srhIdx = src.indexOf('setRequestHeader');
if (srhIdx >= 0) {
  log.info(`\n=== 'setRequestHeader' 上下文 (位置 ${srhIdx}) ===`);
  log.info(src.substring(Math.max(0, srhIdx - 200), srhIdx + 300));
}

// 16. 找 XMLHttpRequest 出现位置
const xhrIdx = src.indexOf('XMLHttpRequest');
if (xhrIdx >= 0) {
  log.info(`\n=== 'XMLHttpRequest' 第一次出现 (位置 ${xhrIdx}) ===`);
  log.info(src.substring(Math.max(0, xhrIdx - 200), xhrIdx + 500));
}

// 17. 查找 signAbogus / createAbogus / getAbogus
const abFnPatterns = ['signAbogus', 'createAbogus', 'getAbogus', 'abyssSign', 'getSign', 'bdmsSign'];
for (const p of abFnPatterns) {
  const idx = src.indexOf(p);
  log.info(`'${p}' 位置: ${idx}`);
  if (idx >= 0) {
    log.info(`  上下文: ${src.substring(Math.max(0, idx - 100), idx + 200)}`);
  }
}

// 18. 找 'aid' 字符串
const aidIdx = src.indexOf('"aid"');
if (aidIdx >= 0) {
  log.info(`\n=== '"aid"' 上下文 (位置 ${aidIdx}) ===`);
  log.info(src.substring(Math.max(0, aidIdx - 200), aidIdx + 200));
}

// 19. 找 0x7380166f SM3 初始 IV
const sm3IvIdx = src.indexOf('0x7380166f');
log.info(`\nSM3 IV (0x7380166f) 位置: ${sm3IvIdx}`);

// 20. 找 'device_platform' 字符串
const dpIdx = src.indexOf('device_platform');
log.info(`'device_platform' 位置: ${dpIdx}`);
if (dpIdx >= 0) {
  log.info(`  上下文: ${src.substring(Math.max(0, dpIdx - 100), dpIdx + 200)}`);
}
