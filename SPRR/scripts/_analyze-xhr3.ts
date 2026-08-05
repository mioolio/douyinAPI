import { readFileSync } from 'fs';

const data = JSON.parse(readFileSync('d:/Desktop/DYCC/SPRR/data/probe-xhr-hook.json', 'utf-8'));
const requests = data.finalRequests as Array<{ url: string; method: string; postData?: string; ts: number }>;

// Find request 64 (notice API)
const noticeReq = requests[64];
const url = noticeReq.url;
console.log('=== Request 64 (notice API) ===');
console.log('Full URL:', url);
console.log();

const aBogusMatch = url.match(/[?&]a_bogus=([^&]+)/);
if (aBogusMatch) {
  const aBogus = decodeURIComponent(aBogusMatch[1]);
  console.log(`a_bogus length: ${aBogus.length}`);
  console.log(`a_bogus: ${aBogus}`);
}

// Also check request 60
const req60 = requests[60];
const aBogus60Match = req60.url.match(/[?&]a_bogus=([^&]+)/);
if (aBogus60Match) {
  const aBogus60 = decodeURIComponent(aBogus60Match[1]);
  console.log('\n=== Request 60 (solution/resource/list) ===');
  console.log(`a_bogus length: ${aBogus60.length}`);
  console.log(`a_bogus: ${aBogus60}`);
}

// Check passport/challenge
const req62 = requests[62];
const signMatch = req62.url.match(/sign=([^&]+)/);
const postSignMatch = req62.postData?.match(/sign=([^&]+)/);
if (signMatch) {
  console.log('\n=== Request 62 (passport challenge) - URL sign ===');
  console.log(`sign: ${signMatch[1].slice(0, 200)}`);
}
if (postSignMatch) {
  console.log('POST sign: ' + postSignMatch[1].slice(0, 200));
}
console.log('POST body: ' + (req62.postData?.slice(0, 500) || 'none'));
