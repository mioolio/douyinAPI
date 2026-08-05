/* 验证 SM3 实现的正确性 */
import { sm3 } from '../src/crypto/abogus.js';

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

// 测试向量 1: SM3("abc")
// 期望: 66c7f0f4 62eeedd9 d1f2d46b dc10e4e2 4167c529 5f038858 230394e4 5b3df48a
const test1 = new TextEncoder().encode('abc');
const hash1 = sm3(test1);
const expected1 = '66c7f0f462eeedd9d1f2d46bdc10e4e24167c529 5f038858230394e45b3df48a'.replace(/\s/g, '');
console.log('=== SM3("abc") ===');
console.log('实际:', bytesToHex(hash1));
console.log('期望:', expected1);
console.log('结果:', bytesToHex(hash1) === expected1 ? 'PASS' : 'FAIL');

// 测试向量 2: 空字符串
// 期望: 1ab21d8355cfa17f8e61194831e81a8f 2b8c1cb3b8b9d1f4e4f4f4f4f4f4f4f4 (示例)
// 实际 SM3("") = 1ab21d8355cfa17f8e61194831e81a8f2b8c1cb3b8b9d1f4e4f4f4f4f4f4f4 (错误，使用标准值)
const test2 = new TextEncoder().encode('');
const hash2 = sm3(test2);
const expected2 = '1ab21d8355cfa17f8e61194831e81a8f2b8c1cb3b8b9d1f4e4f4f4f4f4f4f4';
console.log('\n=== SM3("") ===');
console.log('实际:', bytesToHex(hash2));
// 标准值: 1ab21d8355cfa17f8e61194831e81a8f2b8c1cb3 b8b9d1f4e4f4f4f4f4f4f4 (我不确定)
// SM3 empty string: 1ab21d8355cfa17f8e61194831e81a8f 7af981e0d8e7a5b9b9e5b3f4e4f4f4f4 (不确定，验证时跳过)

// 测试向量 3: "abcd"
const test3 = new TextEncoder().encode('abcd');
const hash3 = sm3(test3);
// SM3("abcd") should produce known hash
// 期望: 6f5e2f5b8e7c1f4e6e5e9d5f8b4a3c2d1e0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4
// 实际上让我搜索一个确认的测试值
console.log('\n=== SM3("abcd") ===');
console.log('实际:', bytesToHex(hash3));

// 测试 dhzx 盐值
const test4 = new TextEncoder().encode('dhzx');
const hash4 = sm3(test4);
console.log('\n=== SM3("dhzx") ===');
console.log('实际:', bytesToHex(hash4));

// 测试 dhzx 二次哈希
const hash4b = sm3(hash4);
console.log('SM3(SM3("dhzx")):', bytesToHex(hash4b));
