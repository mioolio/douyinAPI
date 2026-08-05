/* 验证 SM3 实现的正确性 */
import { sm3 } from '../src/crypto/abogus.js';

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

// 标准测试向量（已与 Node.js crypto 内置 SM3、GmSSL CLI、BouncyCastle Java 库交叉验证）
// 来源：https://cloud.tencent.com/developer/article/1592256
//       GmSSL: SM3("abc") = 66c7f0f4...4167c4875cf2f7a2297da02b8f4ba8e0
const tests: Array<{ input: string; expected: string; name: string }> = [
  {
    input: 'abc',
    expected: '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0',
    name: 'SM3("abc")',
  },
  {
    input: 'abcd',
    expected: '82ec580fe6d36ae4f81cae3c73f4a5b3b5a09c943172dc9053c69fd8e18dca1e',
    name: 'SM3("abcd")',
  },
];

let allPass = true;
for (const t of tests) {
  const data = new TextEncoder().encode(t.input);
  const hash = bytesToHex(sm3(data));
  const pass = hash === t.expected;
  if (!pass) allPass = false;
  console.log(`${t.name}: ${pass ? 'PASS' : 'FAIL'}`);
  if (!pass) {
    console.log(`  expected: ${t.expected}`);
    console.log(`  actual:   ${hash}`);
  }
}

// 二次哈希测试（a_bogus 用到）
const abcHash = sm3(new TextEncoder().encode('abc'));
const abcHash2 = sm3(abcHash);
console.log(`\nSM3(SM3("abc")): ${bytesToHex(abcHash2)}`);

// dhzx 盐值测试
const dhzxHash = sm3(new TextEncoder().encode('dhzx'));
console.log(`SM3("dhzx"): ${bytesToHex(dhzxHash)}`);
const dhzxHash2 = sm3(dhzxHash);
console.log(`SM3(SM3("dhzx")): ${bytesToHex(dhzxHash2)}`);

console.log(`\n${allPass ? '✓ 所有测试通过' : '✗ 有测试失败'}`);
process.exit(allPass ? 0 : 1);
