/**
 * 提取 webmssdk Z-table 中所有字符串
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const file = path.join(__dirname, '..', 'data', 'capture', 'webmssdk.es5.js');
  const src = await fs.readFile(file, 'utf-8');

  // 寻找字符串数组
  // webmssdk 通常是 var _0xXXXX = ["str1", "str2", ...];
  const arrMatch = src.match(/\["[a-zA-Z0-9+/=_\-]{4,}",/g);
  if (arrMatch) {
    const uniq = [...new Set(arrMatch.map((s) => s.match(/"([^"]+)"/)?.[1]).filter(Boolean))];
    console.log(`找到 ${uniq.length} 个唯一长字符串:`);
    for (const s of uniq.slice(0, 100)) {
      console.log(`  ${s.substring(0, 80)}`);
    }
  }

  // 找 secsdk 相关的字符串
  console.log('\n=== secsdk 关键词 ===');
  for (const kw of ['secsdk', 'web-signature', 'timestamp', 'sign', 'a_bogus', 'X-Bogus', 'csrf']) {
    const re = new RegExp(`['"]([^'"]*${kw}[^'"]*)['"]`, 'g');
    const matches: string[] = [];
    let m;
    while ((m = re.exec(src)) !== null) {
      matches.push(m[1]);
    }
    if (matches.length > 0) {
      console.log(`${kw}: ${[...new Set(matches)].slice(0, 5).join(', ')}`);
    }
  }
}

main().catch(console.error);
