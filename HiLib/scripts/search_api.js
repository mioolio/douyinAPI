const fs = require('fs');
const dir = 'data/capture/js';
const files = fs.readdirSync(dir);
const seen = new Set();
for (const f of files) {
  const s = fs.readFileSync(dir + '/' + f, 'utf-8');
  // Find all URL-like strings containing /aweme/v1/web/
  const re = /['"`]([^'"`]*\/aweme\/v1\/web\/[^'"`]*)['"`]/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      console.log(f + ': ' + m[1]);
    }
  }
}
// Also search for encrypt_info decode/decrypt functions
console.log('\n=== encrypt_info decode ===');
for (const f of files) {
  const s = fs.readFileSync(dir + '/' + f, 'utf-8');
  let i = 0;
  while ((i = s.indexOf('encrypt_info', i)) !== -1) {
    const ctx = s.substring(Math.max(0, i - 200), i + 300).replace(/\n/g, ' ');
    console.log(f + ' @ ' + i + ': ' + ctx.substring(0, 500));
    console.log();
    i += 12;
  }
}
