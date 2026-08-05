import { readFileSync } from 'fs';

const data = JSON.parse(readFileSync('d:/Desktop/DYCC/SPRR/data/probe-xhr-hook.json', 'utf-8'));
const requests = data.finalRequests as Array<{ url: string; method: string; postData?: string; ts: number }>;

console.log('=== ALL final requests ===');
for (let i = 0; i < requests.length; i++) {
  const req = requests[i];
  const path = req.url.split('?')[0].replace('https://www.douyin.com', '');
  const urlQuery = req.url.split('?')[1] || '';
  // Get last 3 params
  const params = urlQuery.split('&');
  const last3 = params.slice(-3).join('&');
  console.log(`[${i}] [${req.method}] ${path} (${params.length} params)`);
  console.log(`    last 3: ${last3}`);
  if (req.postData) {
    console.log(`    POST: ${req.postData.slice(0, 100)}...`);
  }
}
