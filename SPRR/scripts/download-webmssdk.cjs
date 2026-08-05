/* 下载 webmssdk.es5.js 并保存到 data/capture/webmssdk.es5.js */
const fs = require('fs');
const path = require('path');

const URLS = [
  'https://lf-c-flwb.bytetos.com/obj/rc-client-security/c-webmssdk/1.0.0.20/webmssdk.es5.js',
  // 兜底：从 douyin.com 拉取
  'https://www.douyin.com/dist/webmssdk.es5.js',
];

async function download(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      accept: '*/*',
      referer: 'https://www.douyin.com/',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  return text;
}

async function main() {
  const outDir = path.join(__dirname, '..', 'data', 'capture');
  await fs.promises.mkdir(outDir, { recursive: true });
  for (const u of URLS) {
    try {
      console.log(`下载: ${u}`);
      const text = await download(u);
      console.log(`  size=${text.length} bytes`);
      const file = path.join(outDir, 'webmssdk.es5.js');
      fs.writeFileSync(file, text, 'utf-8');
      console.log(`  保存到: ${file}`);
      // 简单分析：搜索关键字
      const keywords = ['a_bogus', 'msToken', 'bdms', 'sign', 'frontierSign', 'bogus', 'navigator', 'XMLHttpRequest'];
      for (const k of keywords) {
        const idx = text.indexOf(k);
        console.log(`  关键字 "${k}": ${idx >= 0 ? `找到 (位置 ${idx})` : '未找到'}`);
      }
      return;
    } catch (e) {
      console.error(`  失败: ${e.message}`);
    }
  }
  console.error('所有 URL 均失败');
  process.exit(1);
}

main();
