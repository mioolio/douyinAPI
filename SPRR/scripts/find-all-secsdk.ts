/**
 * 查找所有带 x-secsdk-web-signature 的最新样本（含 bd_ticket_guard_ts_sign_id）
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_DIR = path.join(__dirname, '..', 'data', 'capture', 'api');

async function main() {
  const files = await fs.readdir(API_DIR);
  const found: string[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(API_DIR, f);
    const text = await fs.readFile(file, 'utf-8');
    if (text.includes('x-secsdk-web-signature')) {
      found.push(f);
    }
  }
  console.log(`共 ${found.length} 个文件包含 x-secsdk-web-signature:`);
  for (const f of found) {
    console.log(`  ${f}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
