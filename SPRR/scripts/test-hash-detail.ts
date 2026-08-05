/**
 * 详细打印所有 32 字节的 SM3 hash，找出实际使用的位置组合
 *
 * 已知 payload 期望:
 *   [10-12] = 01 03 3a  (url hash)
 *   [13-15] = 18 03 82  (body hash)
 *   [16-18] = 9f 00 22  (ua hash)
 */
import { sm3 } from '../src/crypto/abogus.js';

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

function printHash(name: string, h: Uint8Array): void {
  const hex = Array.from(h).map((b) => b.toString(16).padStart(2, '0')).join(' ');
  console.log(`\n${name}:`);
  console.log(`  ${hex}`);
}

function findCombinations(h: Uint8Array, expected: [number, number, number]): void {
  const [e0, e1, e2] = expected;
  const found: Array<[number, number, number]> = [];
  for (let i = 0; i < 32; i++) {
    for (let j = 0; j < 32; j++) {
      for (let k = 0; k < 32; k++) {
        if (h[i] === e0 && h[j] === e1 && h[k] === e2) {
          found.push([i, j, k]);
        }
      }
    }
  }
  console.log(`  匹配 [${e0.toString(16)}, ${e1.toString(16)}, ${e2.toString(16)}] 的位置:`, found.slice(0, 20));
}

console.log('========== URL hash 详细分析 ==========');
const urlHash1 = sm3(new TextEncoder().encode(URL_NO_BOGUS + SALT));
const urlHash2 = sm3(urlHash1);
printHash('URL_NO_BOGUS + dhzx (双 SM3)', urlHash2);
console.log('  期望: 01 03 3a');
findCombinations(urlHash2, [0x01, 0x03, 0x3a]);

// 单次 SM3
const urlHash1Single = sm3(new TextEncoder().encode(URL_NO_BOGUS + SALT));
printHash('URL_NO_BOGUS + dhzx (单 SM3)', urlHash1Single);
findCombinations(urlHash1Single, [0x01, 0x03, 0x3a]);

// 无 salt
const urlHashNoSalt = sm3(sm3(new TextEncoder().encode(URL_NO_BOGUS)));
printHash('URL_NO_BOGUS (无 salt, 双 SM3)', urlHashNoSalt);
findCombinations(urlHashNoSalt, [0x01, 0x03, 0x3a]);

console.log('\n========== Body hash 详细分析 ==========');
const bodyHash1 = sm3(new TextEncoder().encode(BODY + SALT));
const bodyHash2 = sm3(bodyHash1);
printHash('BODY + dhzx (双 SM3)', bodyHash2);
console.log('  期望: 18 03 82');
findCombinations(bodyHash2, [0x18, 0x03, 0x82]);

const bodyHashNoSalt = sm3(sm3(new TextEncoder().encode(BODY)));
printHash('BODY (无 salt, 双 SM3)', bodyHashNoSalt);
findCombinations(bodyHashNoSalt, [0x18, 0x03, 0x82]);

console.log('\n========== UA hash 详细分析 ==========');
const uaHash1 = sm3(new TextEncoder().encode(uaB64));
printHash('UA b64 (单 SM3)', uaHash1);
console.log('  期望: 9f 00 22');
findCombinations(uaHash1, [0x9f, 0x00, 0x22]);

const uaHash1WithSalt = sm3(new TextEncoder().encode(uaB64 + SALT));
printHash('UA b64 + dhzx (单 SM3)', uaHash1WithSalt);
findCombinations(uaHash1WithSalt, [0x9f, 0x00, 0x22]);

// 试一下其他 UA 处理方式
const uaHashBytes = sm3(new TextEncoder().encode(UA));
printHash('UA bytes (单 SM3)', uaHashBytes);
findCombinations(uaHashBytes, [0x9f, 0x00, 0x22]);

// 三次 SM3 测试
console.log('\n========== 三次 SM3 测试 ==========');
const urlHash3 = sm3(sm3(sm3(new TextEncoder().encode(URL_NO_BOGUS + SALT))));
printHash('URL 三次 SM3', urlHash3);
findCombinations(urlHash3, [0x01, 0x03, 0x3a]);

// 试一下 sm3 once
const urlHashOnce = sm3(new TextEncoder().encode(URL_NO_BOGUS + SALT));
printHash('URL 单次 SM3', urlHashOnce);
findCombinations(urlHashOnce, [0x01, 0x03, 0x3a]);
