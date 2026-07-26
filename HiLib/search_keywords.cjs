const fs = require('fs');
const path = require('path');

const dir = 'D:/Desktop/DYCC/SPRR';
const jsDir = path.join(dir, 'data/capture/js');
const files = fs.readdirSync(jsDir).filter(f => f.endsWith('.js'));

const keywords = [
  'is_change_view', 'isChangeView', 'change_view', 'changeView',
  'permanent', 'encrypt_info', 'encryptInfo',
  'image_info', 'imageInfo', 'sessionKey', 'session_key',
  'image_id', 'imageId', 'photoId', 'photo_id',
  'build_image', 'buildImage',
  'cipher', 'Cipher',
  'decrypt_image', 'decryptImage',
  'get_image', 'getImage',
  'read_once', 'readOnce',
  'AES', 'aes',
  'GCM', 'gcm',
  'skey',
  'show_once', 'showOnce',
  'crypto.subtle', 'importKey', 'deriveKey',
  'origin_url', 'large_url',
  'resource_url', 'resourceUrl',
];

console.log('=== Searching JS files in', jsDir, '===');
for (const f of files) {
  const p = path.join(jsDir, f);
  const c = fs.readFileSync(p, 'utf8');
  const found = [];
  for (const kw of keywords) {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(escaped, 'g');
    const matches = [];
    let m;
    while ((m = re.exec(c)) !== null) {
      matches.push(m.index);
      if (matches.length >= 3) break;
    }
    if (matches.length > 0) found.push({ kw, count: matches.length, offsets: matches.slice(0, 3) });
  }
  if (found.length > 0) {
    console.log(`\n--- ${f} (size=${c.length}) ---`);
    for (const x of found) {
      console.log(`  ${x.kw}: ${x.count} hits at offsets ${x.offsets.join(', ')}`);
      // print small snippet around first hit
      const o = x.offsets[0];
      const start = Math.max(0, o - 80);
      const end = Math.min(c.length, o + x.kw.length + 80);
      let snippet = c.slice(start, end).replace(/\s+/g, ' ');
      console.log(`    snippet: ...${snippet}...`);
    }
  }
}
