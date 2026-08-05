import { readFileSync } from 'fs';

const data = JSON.parse(readFileSync('d:/Desktop/DYCC/SPRR/data/probe-xhr-hook.json', 'utf-8'));
const requests = data.finalRequests as Array<{ url: string; method: string; postData?: string; ts: number }>;

console.log(`Total final requests: ${requests.length}\n`);

// Find a_bogus and X-Bogus values
const enriched: any[] = [];
for (const req of requests) {
  const url = req.url;
  const aBogusMatch = url.match(/[?&]a_bogus=([^&]+)/);
  const xBogusMatch = url.match(/[?&]X-Bogus=([^&]+)/);
  enriched.push({
    method: req.method,
    path: url.split('?')[0].replace('https://www.douyin.com', ''),
    aBogus: aBogusMatch?.[1],
    xBogus: xBogusMatch?.[1],
    hasPost: !!req.postData,
    postLen: req.postData?.length || 0,
  });
}

console.log('=== Sample requests with a_bogus ===');
for (const r of enriched.slice(0, 10)) {
  if (r.aBogus) {
    console.log(`[${r.method}] ${r.path}`);
    console.log(`  a_bogus(${r.aBogus.length}): ${r.aBogus.slice(0, 60)}...`);
    if (r.xBogus) console.log(`  X-Bogus(${r.xBogus.length}): ${r.xBogus}`);
    if (r.hasPost) console.log(`  POST body: ${r.postLen} bytes`);
    console.log('');
  }
}

// Show unique a_bogus length distribution
const lengths = enriched.filter(r => r.aBogus).map(r => r.aBogus.length);
const lenCounts: Record<number, number> = {};
for (const l of lengths) lenCounts[l] = (lenCounts[l] || 0) + 1;
console.log('\n=== a_bogus length distribution ===');
for (const [l, c] of Object.entries(lenCounts).sort((a, b) => Number(b[0]) - Number(a[0]))) {
  console.log(`  len=${l}: ${c} requests`);
}
