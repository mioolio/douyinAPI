const fs = require('fs');
const path = require('path');

const jsDir = 'D:/Desktop/DYCC/SPRR/data/capture/js';
const files = fs.readdirSync(jsDir).filter(f => f.endsWith('.js'));

console.log('=== Searching for image-related API URLs ===');
const urlPattern = /["'`](\/aweme\/v[0-9]+\/web\/[^"'`]*?(?:image|photo|encrypt|decrypt|cipher|read_once|build_image|im)[^"'`]*?)["'`]/g;

for (const f of files) {
  const p = path.join(jsDir, f);
  const c = fs.readFileSync(p, 'utf8');
  const found = new Set();
  let m;
  while ((m = urlPattern.exec(c)) !== null) {
    found.add(m[1]);
  }
  if (found.size > 0) {
    console.log(`\n--- ${f} ---`);
    for (const url of found) console.log(`  ${url}`);
  }
}

console.log('\n\n=== Searching for encrypt_info in all files (raw, any case) ===');
const encPattern = /encrypt[_-]?info/gi;
for (const f of files) {
  const p = path.join(jsDir, f);
  const c = fs.readFileSync(p, 'utf8');
  const matches = [];
  let m;
  while ((m = encPattern.exec(c)) !== null) {
    matches.push(m.index);
  }
  if (matches.length > 0) {
    console.log(`\n--- ${f}: ${matches.length} matches ---`);
    for (const o of matches.slice(0, 3)) {
      const start = Math.max(0, o - 100);
      const end = Math.min(c.length, o + 100);
      console.log(`  @${o}: ...${c.slice(start, end).replace(/\s+/g, ' ')}...`);
    }
  }
}

console.log('\n\n=== Searching for is_change_view (raw, any case) ===');
const cvPattern = /is[_-]?change[_-]?view/gi;
for (const f of files) {
  const p = path.join(jsDir, f);
  const c = fs.readFileSync(p, 'utf8');
  const matches = [];
  let m;
  while ((m = cvPattern.exec(c)) !== null) {
    matches.push(m.index);
  }
  if (matches.length > 0) {
    console.log(`\n--- ${f}: ${matches.length} matches ---`);
  }
}
console.log('Search complete.');

console.log('\n\n=== Searching for "encrypt_info" / "encryptInfo" in all capture data ===');
const apiDir = 'D:/Desktop/DYCC/SPRR/data/capture/api';
const apiFiles = fs.readdirSync(apiDir);
for (const f of apiFiles) {
  const p = path.join(apiDir, f);
  const c = fs.readFileSync(p, 'utf8');
  if (/encrypt[_-]?info/i.test(c)) {
    console.log(`  API file: ${f}`);
  }
}

console.log('\n=== Searching for "is_change_view" / "isChangeView" in all capture data ===');
for (const f of apiFiles) {
  const p = path.join(apiDir, f);
  const c = fs.readFileSync(p, 'utf8');
  if (/is[_-]?change[_-]?view/i.test(c)) {
    console.log(`  API file: ${f}`);
  }
}

console.log('\n=== Searching in requests dir ===');
const reqDir = 'D:/Desktop/DYCC/SPRR/data/capture/requests';
const reqFiles = fs.readdirSync(reqDir);
let found = 0;
for (const f of reqFiles) {
  const p = path.join(reqDir, f);
  const c = fs.readFileSync(p, 'utf8');
  if (/is[_-]?change[_-]?view/i.test(c)) {
    console.log(`  REQ file: ${f}`);
    found++;
  }
  if (/encrypt[_-]?info/i.test(c)) {
    console.log(`  REQ file (encrypt_info): ${f}`);
    found++;
  }
  if (found > 30) break;
}
console.log('Search complete.');
