/**
 * 重新追踪 a_bogus 生成，捕获完整的 JSON 字符串
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const __dirname = '';

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
});
const page = await context.newPage();

// Inject hooks to capture all btoa / TextEncoder / JSON.stringify calls
await page.addInitScript(() => {
  const origBtoa = window.btoa;
  const origAtob = window.atob;
  const origJSONStringify = JSON.stringify;
  const origTextEncoder = TextEncoder.prototype.encode;
  const captures: any[] = [];

  function bytesToHex(bytes: Uint8Array, maxLen = 200): string {
    return Array.from(bytes.slice(0, maxLen))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');
  }

  function stringPreview(s: string, maxLen = 300): string {
    if (s.length > maxLen) return s.slice(0, maxLen) + `... (len=${s.length})`;
    return s;
  }

  // Hook btoa
  (window as any).btoa = function (input: string) {
    const inBytes = new TextEncoder().encode(input);
    const out = origBtoa(input);
    captures.push({
      type: 'btoa',
      ts: performance.now(),
      in_len: inBytes.length,
      in_hex: bytesToHex(inBytes),
      in_preview: stringPreview(input),
      out,
    });
    return out;
  };

  // Hook atob
  (window as any).atob = function (input: string) {
    const out = origAtob(input);
    let outBytes: Uint8Array;
    try {
      outBytes = new TextEncoder().encode(out);
    } catch {
      outBytes = new Uint8Array();
    }
    captures.push({
      type: 'atob',
      ts: performance.now(),
      in_len: input.length,
      in_preview: stringPreview(input),
      out_len: outBytes.length,
      out_preview: stringPreview(out),
    });
    return out;
  };

  // Hook JSON.stringify
  (window as any).__captures = captures;

  // Hook byted_acrawler if available
  const interval = setInterval(() => {
    const ac = (window as any).byted_acrawler;
    if (ac) {
      console.log('FOUND byted_acrawler');
      clearInterval(interval);
    }
  }, 100);
});

await page.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);

// Manually trigger a_bogus by making an API call
console.log('Triggering notice API call...');
const result = await page.evaluate(async () => {
  const url = '/aweme/v1/web/im/notice/?notice_group=960';
  try {
    const resp = await fetch(url, { credentials: 'include' });
    return { status: resp.status, ok: resp.ok };
  } catch (e: any) {
    return { error: e.message };
  }
});
console.log('API result:', result);
await page.waitForTimeout(2000);

const captures = await page.evaluate(() => (window as any).__captures || []);
console.log(`Captured ${captures.length} btoa/atob events`);

writeFileSync('d:/Desktop/DYCC/SPRR/data/trace-abogus-v2.json', JSON.stringify({ captures }, null, 2));
console.log('Saved to data/trace-abogus-v2.json');

await browser.close();
