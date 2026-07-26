const fs = require('fs');

// 1. Read the full 3530 worker file (the imageDecryptor)
const file3530 = 'D:/Desktop/DYCC/SPRR/data/capture/js/f9427dab3065_3530.a56b2fb0.js';
const c3530 = fs.readFileSync(file3530, 'utf8');
console.log('=== 3530 worker file (imageDecryptor) FULL CONTENT ===');
console.log(c3530);
console.log('\n\n=== END 3530 worker file ===\n\n');

// 2. In e445, find the aP function (calls /aweme/v1/web/im/read_once/detail)
const fileE445 = 'D:/Desktop/DYCC/SPRR/data/capture/js/e445bc994f58___federation_expose_default_export.d40e64ca.js';
const c445 = fs.readFileSync(fileE445, 'utf8');

// Search for "read_once/detail" function
let idx = c445.indexOf('read_once/detail');
while (idx >= 0) {
  const start = Math.max(0, idx - 800);
  const end = Math.min(c445.length, idx + 600);
  console.log(`\n=== read_once/detail context @${idx} ===`);
  console.log(c445.slice(start, end));
  idx = c445.indexOf('read_once/detail', idx + 1);
  if (idx > 0 && idx < c445.length) {
    // Continue
  } else break;
}

// 3. Find the full nT function and imageDecryptor setup
idx = c445.indexOf('imageDecryptor');
while (idx >= 0) {
  const start = Math.max(0, idx - 400);
  const end = Math.min(c445.length, idx + 400);
  console.log(`\n=== imageDecryptor @${idx} ===`);
  console.log(c445.slice(start, end));
  idx = c445.indexOf('imageDecryptor', idx + 1);
}

// 4. Find the cipher algorithm constant ia="aes-256-gcm"
idx = c445.indexOf('aes-256-gcm');
while (idx >= 0) {
  const start = Math.max(0, idx - 300);
  const end = Math.min(c445.length, idx + 500);
  console.log(`\n=== aes-256-gcm context @${idx} ===`);
  console.log(c445.slice(start, end));
  idx = c445.indexOf('aes-256-gcm', idx + 1);
}

// 5. Look for "tkey" usage in e445
idx = c445.indexOf('tkey');
let count = 0;
while (idx >= 0 && count < 3) {
  const start = Math.max(0, idx - 200);
  const end = Math.min(c445.length, idx + 200);
  console.log(`\n=== tkey @${idx} ===`);
  console.log(c445.slice(start, end));
  idx = c445.indexOf('tkey', idx + 1);
  count++;
}
