/**
 * 详细分析捕获的 hash bytes，尝试不同的 hash 算法和输入
 *
 * 已知 payload 期望 (来自真实样本):
 *   url_hash bytes:  01 03 3a
 *   body_hash bytes: 18 03 82
 *   ua_hash bytes:   9f 00 22
 *
 * 测试不同的 hash 算法和输入格式
 */
import { sm3 } from '../src/crypto/abogus.js';
import { createHash } from 'crypto';

const SALT = 'dhzx';

const URL_NO_BOGUS = 'device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1&pc_libra_divert=Windows&update_version_code=170400&support_h265=1&support_dash=1&version_code=170400&version_name=17.4.0&cookie_enabled=true&screen_width=1400&screen_height=900&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=130.0.0.0&browser_online=true&engine_name=Blink&engine_version=130.0.0.0&os_name=Windows&os_version=10&cpu_core_num=12&device_memory=16&platform=PC&downlink=10&effective_type=4g&round_trip_time=150&webid=7664632488053343786&uifid=63bdc4b4b456901f349a081bfd3a24da10a1c6623f0a2d5eadd83f51c9f4d112c8d77359e1afba2b2be01006bc0aece33cb4b4c317c4fb1482a4c71bf4090e94b81c0951edb60ee7bad032e7f14ee4e1862f4c822108604ac966c8a51f20a726&verifyFp=verify_mrtdqm6u_WPtwB28B_3Ql8_4vB9_8KN5_MWb7gkGJjbHR&fp=verify_mrtdqm6u_WPtwB28B_3Ql8_4vB9_8KN5_MWb7gkGJjbHR&msToken=7MlZsficXw4FtR8Ls0QCjLFaqGa_bP1tBIZc48KTy2ITgN5-tBqH5c7gJ3kModIEk_aETdAy5tVweYYSKCxbGdt8a4VXGgmrclAFPiePIXp6SUn4eoxTEnImAiEHV8SQq57HM0VTyc6AXk2Ei2sMIBuRahPyk8ZoOuJDqOixxiMEpH98MLMRgfuP';
const BODY = 'author_id=328083366478496&aweme_id=7417844885643988275&pre_item_id=7662765667309312697&pre_item_seen=0';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const S3_TABLE = 'ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe';

function customBase64Encode(data: Uint8Array, table: string): string {
  let out = '';
  for (let i = 0; i < data.length; i += 3) {
    const b0 = data[i];
    const b1 = i + 1 < data.length ? data[i + 1] : 0;
    const b2 = i + 2 < data.length ? data[i + 2] : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += table[(triple >> 18) & 0x3f];
    out += table[(triple >> 12) & 0x3f];
    if (i + 1 < data.length) out += table[(triple >> 6) & 0x3f];
    if (i + 2 < data.length) out += table[triple & 0x3f];
  }
  return out;
}

const uaB64 = customBase64Encode(new TextEncoder().encode(UA), S3_TABLE);

// 自定义测试 - 用 MD5 试试
function md5Hex(s: string | Buffer): string {
  return createHash('md5').update(s).digest('hex');
}

function md5Bytes(s: string | Buffer): number[] {
  return Array.from(createHash('md5').update(s).digest());
}

console.log('========== MD5 哈希测试 ==========');
console.log('URL_NO_BOGUS + dhzx:');
const urlMd5 = md5Bytes(URL_NO_BOGUS + SALT);
console.log(`  ${urlMd5.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
console.log(`  期望: 01 03 3a (3 字节)`);
console.log(`  尝试找 01 03 3a 位置:`);
for (let i = 0; i < 16; i++) {
  if (urlMd5[i] === 0x01) {
    console.log(`    [${i}] = 0x01, [${i+1}] = 0x${urlMd5[i+1].toString(16)}, [${i+2}] = 0x${urlMd5[i+2].toString(16)}`);
  }
}

console.log('\nURL_NO_BOGUS (no salt):');
const urlMd5NoSalt = md5Bytes(URL_NO_BOGUS);
console.log(`  ${urlMd5NoSalt.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);

// 试 SHA1
function sha1Bytes(s: string | Buffer): number[] {
  return Array.from(createHash('sha1').update(s).digest());
}

console.log('\n========== SHA1 哈希测试 ==========');
console.log('URL_NO_BOGUS + dhzx:');
const urlSha1 = sha1Bytes(URL_NO_BOGUS + SALT);
console.log(`  ${urlSha1.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);

// 试 SHA256
function sha256Bytes(s: string | Buffer): number[] {
  return Array.from(createHash('sha256').update(s).digest());
}

console.log('\n========== SHA256 哈希测试 ==========');
console.log('URL_NO_BOGUS + dhzx:');
const urlSha256 = sha256Bytes(URL_NO_BOGUS + SALT);
console.log(`  ${urlSha256.map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);

// 完整 SM3 hash
console.log('\n========== 完整 SM3 hash (32 字节) ==========');
const urlHashFull = sm3(sm3(new TextEncoder().encode(URL_NO_BOGUS + SALT)));
console.log(`URL_NO_BOGUS + dhzx 双 SM3:`);
console.log(`  ${Array.from(urlHashFull).map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);

// 关键问题：bytes 01, 03, 3a, 18, 03, 82, 9f, 00, 22 有什么共同点？
console.log('\n========== 字节序列分析 ==========');
console.log('URL hash bytes: 01 03 3a');
console.log('Body hash bytes: 18 03 82');
console.log('UA hash bytes: 9f 00 22');

// 组合：每三个相邻字节
const allBytes = [
  0x01, 0x03, 0x3a,
  0x18, 0x03, 0x82,
  0x9f, 0x00, 0x22,
];
console.log('完整 9 字节:', allBytes.map((b) => b.toString(16).padStart(2, '0')).join(' '));

// 寻找 sm3 hash 中含 03 3a 的位置
console.log('\n寻找 SM3 URL hash 中含 0x3a 0x03 的位置:');
for (let i = 0; i < 31; i++) {
  if (urlHashFull[i] === 0x3a && urlHashFull[i+1] === 0x03) {
    console.log(`  [${i}, ${i+1}] = 0x3a 0x03`);
  }
}

console.log('\n========== 反向：尝试从 3a 找到 url hash 位置组合 ==========');
// 我们已知 url_hash[3] = 0x3a
// 看 url hash 中是否还有其他位置的 0x01, 0x03
for (let i = 0; i < 32; i++) {
  console.log(`  urlHash[${i}] = 0x${urlHashFull[i].toString(16).padStart(2, '0')}`);
}

console.log('\n期望 [10]=0x01 [11]=0x03 [12]=0x3a');
console.log('我们的 url hash: [0..18]');
for (let i = 0; i < 19; i++) {
  console.log(`  [${i}] = 0x${urlHashFull[i].toString(16).padStart(2, '0')}`);
}
