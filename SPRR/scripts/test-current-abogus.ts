/**
 * 测试当前 a_bogus.ts 生成的签名长度和质量
 * 不发送请求，只看生成结果
 */
import { generateABogus } from '../src/crypto/abogus.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const params = {
  device_platform: 'webapp',
  aid: '6383',
  channel: 'channel_pc_web',
  sec_user_id: 'MS4wLjABAAAAt1-tyTCsVHPn9nxlcYnY4olIvO-DxMtS6VNLiNN16mE',
  max_cursor: '0',
  count: '18',
  pc_client_type: '1',
};

const result = generateABogus({
  url: '/aweme/v1/web/aweme/post/',
  params,
  method: 'GET',
  userAgent: UA,
});

console.log(`a_bogus 长度: ${result.length}`);
console.log(`a_bogus: ${result}`);
console.log(`期望长度: 188 (浏览器) | 我们的长度: ${result.length}`);
console.log(`差值: ${188 - result.length} 字符 = ${((188 - result.length) * 3 / 4).toFixed(1)} 字节`);
