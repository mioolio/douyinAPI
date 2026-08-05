/**
 * 分析 webmssdk.es5.js 源码，定位 a_bogus 生成入口
 */
import { readFileSync } from 'fs';
import { createLogger } from '../src/utils/logger.js';

const log = createLogger('analyze-webmssdk-src');

const src = readFileSync('d:/Desktop/DYCC/SPRR/data/capture/webmssdk.es5.js', 'utf-8');
const src2 = readFileSync('d:/Desktop/DYCC/SPRR/data/capture/js/b4ffe03f6783_webmssdk.es5.js', 'utf-8');
log.info(`webmssdk.es5.js 总长度: ${src.length} 字符 (捕获) / ${src2.length} 字符 (备用)`);
const allSrc = src + '\n' + src2;

// 1. 找所有可识别的函数和变量名
const patterns: Array<{ name: string; re: RegExp }> = [
  { name: 'XHR.open', re: /XHR\.open|XHR\[.open.\]|\bopen\s*[:=]/g },
  { name: 'XHR.send', re: /XHR\.send|XHR\[.send.\]|\bsend\s*[:=]/g },
  { name: 'XHR.setRequestHeader', re: /setRequestHeader/g },
  { name: 'a_bogus 字符串', re: /['"]a_bogus['"]/g },
  { name: 'X-Bogus 字符串', re: /['"]X-Bogus['"]/g },
  { name: '_$webrt_', re: /\$webrt_/g },
  { name: 'byted_acrawler', re: /byted_acrawler/g },
  { name: 'frontierSign', re: /frontierSign/g },
  { name: 'JSVMP magic', re: /magic\s+number/gi },
  { name: 'aByss/Abogus', re: /[aA]byss[a-zA-Z_]*/g },
  { name: 'CreateBogus', re: /createBogus/gi },
  { name: 'GetSign', re: /getSign/gi },
  { name: 'bdms', re: /bdms/gi },
];

for (const p of patterns) {
  const matches = src.match(p.re) || [];
  log.info(`${p.name}: ${matches.length} 次出现`);
  if (matches.length > 0 && matches.length < 10) {
    log.info(`  示例: ${matches.slice(0, 5).join(', ')}`);
  }
}

// 2. 找 _0x30e1fc (frontierSign function) 的位置
const frontierIdx = src.indexOf('_0x30e1fc');
log.info(`\nfrontierSign function (_0x30e1fc) 位置: ${frontierIdx}`);

// 3. 找 _0x4dff2d (init function) 的位置
const initIdx = src.indexOf('_0x4dff2d');
log.info(`init function (_0x4dff2d) 位置: ${initIdx}`);

// 4. 找 _0x3fe78d (getReferer function) 的位置
const getRefererIdx = src.indexOf('_0x3fe78d');
log.info(`getReferer function (_0x3fe78d) 位置: ${getRefererIdx}`);

// 5. 找 _0x32bbd2 (init caller) 的位置
const initCallerIdx = src.indexOf('_0x32bbd2');
log.info(`init caller (_0x32bbd2) 位置: ${initCallerIdx}`);

// 6. 查找所有 _$webrt_ 函数的定义位置
const jsvmpRegex = /\$webrt_\d+/g;
let match: RegExpExecArray | null;
const jsvmpPositions: Array<{ name: string; pos: number }> = [];
while ((match = jsvmpRegex.exec(src)) !== null) {
  jsvmpPositions.push({ name: match[0], pos: match.index });
}
log.info(`\n找到 ${jsvmpPositions.length} 个 _$webrt_ 引用`);
const uniqueJsvmp = Array.from(new Set(jsvmpPositions.map((p) => p.name)));
log.info(`不同的 JSVMP 函数名: ${uniqueJsvmp.length} 个`);
for (const name of uniqueJsvmp) {
  const positions = jsvmpPositions.filter((p) => p.name === name).map((p) => p.pos);
  log.info(`  ${name}: 位置 [${positions.slice(0, 5).join(', ')}${positions.length > 5 ? '...' : ''}]`);
}

// 7. 查找 XHR hook 相关代码
const xhrHookRe = /function\s*\(\s*[a-z]\s*,\s*[a-z]\s*\)\s*\{[^}]*XMLHttpRequest[^}]*\}/g;
const xhrHooks = src.match(xhrHookRe) || [];
log.info(`\nXHR hook 函数: ${xhrHooks.length} 个`);

// 8. 查找 'open' 和 'send' 作为 key
const openKeyRe = /['"]open['"]\s*:/g;
const sendKeyRe = /['"]send['"]\s*:/g;
log.info(`'open' 作为 key 出现: ${(src.match(openKeyRe) || []).length} 次`);
log.info(`'send' 作为 key 出现: ${(src.match(sendKeyRe) || []).length} 次`);

// 9. 看 frontierSign 函数源码
if (frontierIdx >= 0) {
  log.info(`\n=== frontierSign 函数源码 ===`);
  log.info(src.substring(frontierIdx - 50, frontierIdx + 800));
}

// 10. 查找函数定义的整体模式 - 找 _0x1b2215 (setConfig) 的位置
const setConfigIdx = src.indexOf('_0x1b2215');
log.info(`\nsetConfig (_0x1b2215) 位置: ${setConfigIdx}`);

// 11. 查找 'init' 作为 function
const initFnRe = /['"]init['"]\s*:\s*function/g;
const initFnMatches = src.match(initFnRe) || [];
log.info(`\n'init' 作为 function 出现: ${initFnMatches.length} 次`);

// 12. 查找 _0x1d19fc (frontierSign 的参数名)
const paramIdx = src.indexOf('_0x1d19fc');
log.info(`\nfrontierSign 参数 (_0x1d19fc) 位置: ${paramIdx}`);

// 13. 查找 _$_initialize 或类似初始化
const initRe = /_?\$\$_?[a-z]+/g;
const initMatches = src.match(initRe) || [];
const uniqueInitMatches = Array.from(new Set(initMatches));
log.info(`\n_$$ 模式: ${uniqueInitMatches.length} 个不同, 出现 ${initMatches.length} 次`);
log.info(`示例: ${uniqueInitMatches.slice(0, 20).join(', ')}`);

// 14. 找 BDMS 引用
const bdmsRe = /['"]bdms['"]/g;
log.info(`\n'bdms' 字符串: ${(src.match(bdmsRe) || []).length} 次`);

// 15. 找 _sign 函数
const signFnRe = /_sign\b/gi;
log.info(`_sign 函数: ${(src.match(signFnRe) || []).length} 次`);

// 16. 找 "version_code" 等参数名
const paramNames = ['aid', 'device_platform', 'webid', 'msToken', 'verifyFp', 'pc_client_type', 'version_code', 'browser_version', 'a_bogus'];
for (const p of paramNames) {
  const re = new RegExp(`['"]${p}['"]`, 'g');
  const count = (src.match(re) || []).length;
  log.info(`'${p}' 字符串: ${count} 次`);
}

// 17. 找 createXhrHook 或类似
const xhrHookRe2 = /XHR\.(?:open|send|setRequestHeader)|originalXhr|origOpen|origSend/gi;
const xhrHookMatches = src.match(xhrHookRe2) || [];
log.info(`\nXHR hook 引用: ${xhrHookMatches.length} 次`);

// 18. 找 BdmsSign / BdmsClass
const bdmsClassRe = /class\s+[A-Z][a-zA-Z]*Bdms/gi;
log.info(`class Bdms*: ${(src.match(bdmsClassRe) || []).length} 次`);

// 19. 找 'X-Bogus' 上下文
const xBogusIdx = src.indexOf('X-Bogus');
if (xBogusIdx >= 0) {
  log.info(`\n=== 'X-Bogus' 上下文 (位置 ${xBogusIdx}) ===`);
  log.info(src.substring(Math.max(0, xBogusIdx - 200), xBogusIdx + 300));
}

// 20. 找 a_bogus 相关
const aBogusIdx = src.indexOf('a_bogus');
if (aBogusIdx >= 0) {
  log.info(`\n=== 'a_bogus' 上下文 (位置 ${aBogusIdx}) ===`);
  log.info(src.substring(Math.max(0, aBogusIdx - 200), aBogusIdx + 300));
} else {
  log.info(`\n'webmssdk.es5.js' 中没有 'a_bogus' 字符串！`);
  log.info(`  a_bogus 是由其他文件生成（如 bdms.js）`);
}
