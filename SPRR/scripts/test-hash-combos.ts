/**
 * 测试不同的 URL/body 组合，找出一致的 SM3 hash 值
 */
import { sm3 } from '../src/crypto/abogus.js';

const SALT = 'dhzx';

const URL_FULL = 'device_platform=webapp&aid=6383&channel=channel_pc_web&pc_client_type=1&pc_libra_divert=Windows&update_version_code=170400&support_h265=1&support_dash=1&version_code=170400&version_name=17.4.0&cookie_enabled=true&screen_width=1400&screen_height=900&browser_language=zh-CN&browser_platform=Win32&browser_name=Chrome&browser_version=130.0.0.0&browser_online=true&engine_name=Blink&engine_version=130.0.0.0&os_name=Windows&os_version=10&cpu_core_num=12&device_memory=16&platform=PC&downlink=10&effective_type=4g&round_trip_time=150&webid=7664632488053343786&uifid=63bdc4b4b456901f349a081bfd3a24da10a1c6623f0a2d5eadd83f51c9f4d112c8d77359e1afba2b2be01006bc0aece33cb4b4c317c4fb1482a4c71bf4090e94b81c0951edb60ee7bad032e7f14ee4e1862f4c822108604ac966c8a51f20a726&verifyFp=verify_mrtdqm6u_WPtwB28B_3Ql8_4vB9_8KN5_MWb7gkGJjbHR&fp=verify_mrtdqm6u_WPtwB28B_3Ql8_4vB9_8KN5_MWb7gkGJjbHR&msToken=7MlZsficXw4FtR8Ls0QCjLFaqGa_bP1tBIZc48KTy2ITgN5-tBqH5c7gJ3kModIEk_aETdAy5tVweYYSKCxbGdt8a4VXGgmrclAFPiePIXp6SUn4eoxTEnImAiEHV8SQq57HM0VTyc6AXk2Ei2sMIBuRahPyk8ZoOuJDqOixxiMEpH98MLMRgfuP&a_bogus=mysVhet7ENAjPd/S8KpJyA2lv7LArsybaBTdRrNPtNY0P70av8NbKuiccKFWAkBwWSphk957pkMoSdDYYT1d2K-kumkDuzwfCz2cn0mLgqwgGFvsgrjzCzmFLwBKUQvEeQnJN17RXsMx2xclnqAsABAGC5F9QOmpWqZbd/uyjDC0pPLTno/9CnTW516=';
const URL_NO_SIG = URL_FULL.replace(/&(a_bogus|msToken|verifyFp|fp|webid|uifid)=[^&]*/g, '');
// 顺序：先拼 path + ? + params，去掉 "a_bogus=..."（签名不能包含自己）
const URL_NO_BOGUS = URL_FULL.replace(/&a_bogus=[^&]*/, '').replace(/&a_bogus=[^&]*/, '');
const BODY = 'author_id=328083366478496&aweme_id=7417844885643988275&pre_item_id=7662765667309312697&pre_item_seen=0';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const S3_TABLE = 'ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe';

// 自定义 Base64
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

console.log('========== SM3 Hash 组合测试 ==========');
console.log(`UA b64: ${uaB64.substring(0, 60)}...`);

const tests = [
  { name: 'URL_FULL', data: URL_FULL + SALT },
  { name: 'URL_NO_SIG', data: URL_NO_SIG + SALT },
  { name: 'URL_NO_BOGUS', data: URL_NO_BOGUS + SALT },
  { name: 'URL_FULL (no salt)', data: URL_FULL },
  { name: 'URL + path', data: '/aweme/v1/web/history/write/?' + URL_FULL + SALT },
  { name: 'URL + path (no a_bogus)', data: '/aweme/v1/web/history/write/?' + URL_NO_BOGUS + SALT },
  { name: 'URL sorted', data: URL_FULL.split('&').sort().join('&') + SALT },
];

for (const t of tests) {
  const h = sm3(sm3(new TextEncoder().encode(t.data)));
  console.log(`\n${t.name}:`);
  console.log(`  [3]=0x${h[3].toString(16).padStart(2, '0')} [9]=0x${h[9].toString(16).padStart(2, '0')} [18]=0x${h[18].toString(16).padStart(2, '0')}`);
}

console.log(`\n期望 (from payload): [10]=0x01 [11]=0x03 [12]=0x3a`);
console.log(`已知: [12]=0x3a 完美匹配 url_hash[3]=0x3a`);

console.log('\n========== Body hash 测试 ==========');
const bodyTests = [
  { name: 'BODY', data: BODY + SALT },
  { name: 'BODY (no salt)', data: BODY },
  { name: 'BODY + path', data: '/aweme/v1/web/history/write/' + BODY + SALT },
];

for (const t of bodyTests) {
  const h = sm3(sm3(new TextEncoder().encode(t.data)));
  console.log(`\n${t.name}:`);
  console.log(`  [4]=0x${h[4].toString(16).padStart(2, '0')} [10]=0x${h[10].toString(16).padStart(2, '0')} [19]=0x${h[19].toString(16).padStart(2, '0')}`);
}
console.log(`\n期望 (from payload): [13]=0x18 [14]=0x03 [15]=0x82`);

console.log('\n========== UA hash 测试 ==========');
const uaTests = [
  { name: 'UA b64', data: uaB64 + SALT },
  { name: 'UA b64 (no salt)', data: uaB64 },
  { name: 'UA bytes', data: UA + SALT },
];

for (const t of uaTests) {
  const h = sm3(new TextEncoder().encode(t.data));
  console.log(`\n${t.name}:`);
  console.log(`  [5]=0x${h[5].toString(16).padStart(2, '0')} [11]=0x${h[11].toString(16).padStart(2, '0')} [21]=0x${h[21].toString(16).padStart(2, '0')}`);
}
console.log(`\n期望 (from payload): [16]=0x9f [17]=0x00 [18]=0x22`);
