/**
 * 分析浏览器生成的真实 a_bogus 字节结构
 *
 * 用 s4 表反查得到原始字节，对比我们的算法生成的字节结构
 */
import { generateABogus, sm3 } from '../src/crypto/abogus.js';

const S4_TABLE = 'Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe';

/** 用 s4 表解码 a_bogus 字符串 → 原始字节 */
function customBase64Decode(s: string): Uint8Array {
  // 末尾的 = 是标准 base64 padding
  const padding = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const core = padding > 0 ? s.slice(0, -padding) : s;
  const out: number[] = [];
  for (let i = 0; i < core.length; i += 4) {
    const c0 = S4_TABLE.indexOf(core[i]);
    const c1 = S4_TABLE.indexOf(core[i + 1]);
    const c2 = i + 2 < core.length ? S4_TABLE.indexOf(core[i + 2]) : -1;
    const c3 = i + 3 < core.length ? S4_TABLE.indexOf(core[i + 3]) : -1;
    if (c0 < 0 || c1 < 0) break;
    const b0 = (c0 << 2) | (c1 >> 4);
    out.push(b0);
    if (c2 >= 0) {
      const b1 = ((c1 & 0xf) << 4) | (c2 >> 2);
      out.push(b1);
      if (c3 >= 0) {
        const b2 = ((c2 & 0x3) << 6) | c3;
        out.push(b2);
      }
    }
  }
  return new Uint8Array(out);
}

function toHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

function toBin(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(2).padStart(8, '0'))
    .join(' ');
}

/** 真实浏览器样本（来自 debug-abogus.ts 捕获） */
const SAMPLES = [
  {
    label: 'GET /aweme/v1/web/social/count',
    method: 'GET',
    a_bogus: 'D70RgHUEx2/VFdMbmOj5y6/lqhylNBSyIliKWEpPyOu9PXFO4SNbKOc/nxqFBuEvbYp0k9V7pnt/bEdcYzUTZo9kumpfudif5t2In0moZqqXTzJsDHjkCz8zowBFUOiEa5nXNlJ5As0rIxQlnNIhAp-a95zqQQRpbrMRd/TyGDS03TLTno2XeavW/qE=',
    params: {
      device_platform: 'webapp',
      aid: '6383',
    },
    body: '',
  },
  {
    label: 'POST /aweme/v2/web/module/feed/',
    method: 'POST',
    a_bogus: 'DyU5D7SwDqQ5FdFGmcjAyUMlf7flNTWy-MiKRLcTtPT4P1Ua4uPbKGN/GOqeBCDvWYp0kCV7Bne1YdjaYG1H/oHpumkfu0h6cT2An8sLgqw6GMksDHjTCL8zLwBe0OJE-Qn7N175WsMxIEclVNITAd-at5FoQYmpbNMfd2T9rDS03s6Tnx/3CnJWG7y=',
    params: {},
    body: '{}',
  },
];

function analyzeSample(s: typeof SAMPLES[0]) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`样本: ${s.label}`);
  console.log(`a_bogus 长度: ${s.a_bogus.length} 字符`);
  const bytes = customBase64Decode(s.a_bogus);
  console.log(`解码后字节数: ${bytes.length}`);
  console.log(`字节(hex): ${toHex(bytes)}`);
  console.log(`字节(bin):`);
  for (let i = 0; i < bytes.length; i += 8) {
    const chunk = bytes.slice(i, i + 8);
    console.log(`  [${i.toString().padStart(3)}] ${toBin(chunk)}`);
  }
}

console.log('========== 浏览器样本分析 ==========');
for (const s of SAMPLES) {
  analyzeSample(s);
}

console.log('\n\n========== 我们生成的样本 ==========');
const ourABogus = generateABogus({
  url: '/aweme/v1/web/social/count',
  params: { device_platform: 'webapp', aid: '6383' },
  method: 'GET',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  body: '',
});
console.log(`a_bogus 长度: ${ourABogus.length} 字符`);
console.log(`a_bogus: ${ourABogus}`);
const ourBytes = customBase64Decode(ourABogus + (ourABogus.length % 4 === 2 ? '==' : ourABogus.length % 4 === 3 ? '=' : ''));
console.log(`解码后字节数: ${ourBytes.length}`);
console.log(`字节(hex): ${toHex(ourBytes)}`);
console.log(`字节(bin):`);
for (let i = 0; i < ourBytes.length; i += 8) {
  const chunk = ourBytes.slice(i, i + 8);
  console.log(`  [${i.toString().padStart(3)}] ${toBin(chunk)}`);
}

console.log('\n\n========== 长度差异分析 ==========');
const browserGetBytes = customBase64Decode(SAMPLES[0].a_bogus);
const ourBytesDecoded = ourBytes;
console.log(`浏览器 GET 字节数: ${browserGetBytes.length}`);
console.log(`我们生成字节数: ${ourBytesDecoded.length}`);
console.log(`差异: ${browserGetBytes.length - ourBytesDecoded.length} 字节`);

console.log('\n========== SM3 测试 ==========');
const sm3Test = sm3(new TextEncoder().encode('abc'));
console.log(`SM3("abc") = ${Array.from(sm3Test).map((b) => b.toString(16).padStart(2, '0')).join('')}`);
console.log(`期望:        66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0`);
