const fs = require('fs');

const file = 'D:/Desktop/DYCC/SPRR/data/capture/js/15c202e7da2f_client-entry_122e3b31.61bca087.js';
const c = fs.readFileSync(file, 'utf8');

// Find all encrypt_info references
const pattern = /encrypt_info/gi;
let m;
let count = 0;
while ((m = pattern.exec(c)) !== null && count < 5) {
  const o = m.index;
  const start = Math.max(0, o - 400);
  const end = Math.min(c.length, o + 400);
  console.log(`\n=== encrypt_info @${o} ===`);
  console.log(c.slice(start, end));
  count++;
}

// Also look for "image" content parsing in this file
console.log('\n\n=== Looking for image content parsing ===');
const imgIdx = c.indexOf('aweType');
let i = 0;
let found = 0;
while ((i = c.indexOf('resource_url', i)) >= 0 && found < 5) {
  const start = Math.max(0, i - 200);
  const end = Math.min(c.length, i + 300);
  console.log(`\n--- resource_url @${i} ---`);
  console.log(c.slice(start, end));
  i++;
  found++;
}

// Check tkey references
console.log('\n\n=== Looking for tkey references ===');
i = 0; found = 0;
while ((i = c.indexOf('tkey', i)) >= 0 && found < 5) {
  const start = Math.max(0, i - 200);
  const end = Math.min(c.length, i + 200);
  console.log(`\n--- tkey @${i} ---`);
  console.log(c.slice(start, end));
  i++;
  found++;
}

// Also check for "cipher" in this file
console.log('\n\n=== Looking for cipher/AES in this file ===');
const patterns = ['cipher', 'Cipher', 'aes-256', 'AES-256', 'aes_gcm', 'AES-GCM', 'gcm', 'GCM', 'crypto.subtle'];
for (const p of patterns) {
  const idx = c.indexOf(p);
  if (idx >= 0) {
    const start = Math.max(0, idx - 150);
    const end = Math.min(c.length, idx + 200);
    console.log(`\n--- ${p} @${idx} ---`);
    console.log(c.slice(start, end));
  }
}
