/**
 * 在 data/capture/js 中搜索包含 a_bogus / x-secsdk-web-signature 的 JS 文件
 * 搜索大小写不敏感
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const dir = path.join(__dirname, '..', 'data', 'capture', 'js');
  const files = await fs.readdir(dir);
  const matches: Array<{ name: string; size: number; keywords: string[] }> = [];

  for (const f of files) {
    if (!f.endsWith('.js')) continue;
    const filePath = path.join(dir, f);
    const stat = await fs.stat(filePath);
    if (stat.size > 5_000_000) continue;
    const content = await fs.readFile(filePath, 'utf-8');
    const found: string[] = [];
    if (/a_bogus/.test(content)) found.push('a_bogus');
    if (/x-secsdk-web-signature/.test(content)) found.push('web-signature');
    if (/x-secsdk-csrf-token/.test(content)) found.push('csrf-token');
    if (/aBogus/.test(content)) found.push('aBogus');
    if (/frontierSign/.test(content)) found.push('frontierSign');
    if (/byted_acrawler/.test(content)) found.push('byted_acrawler');
    if (/webmssdk/.test(content)) found.push('webmssdk');
    if (/MS_SLARDAR/.test(content)) found.push('MS_SLARDAR');
    if (/^\s*var\s+bdms_/.test(content)) found.push('bdms_');
    if (found.length > 0) {
      matches.push({ name: f, size: stat.size, keywords: found });
    }
  }

  console.log(`找到 ${matches.length} 个匹配文件:`);
  for (const m of matches) {
    console.log(`  ${m.name} (${m.size} bytes) [${m.keywords.join(', ')}]`);
  }
}

main().catch(console.error);
