const fs = require('fs');

// Extract more context from 8d5f508b6da3_21133.5b512291.js
const file1 = 'D:/Desktop/DYCC/SPRR/data/capture/js/8d5f508b6da3_21133.5b512291.js';
const c1 = fs.readFileSync(file1, 'utf8');

function snippet(content, offset, before, after, label) {
  const start = Math.max(0, offset - before);
  const end = Math.min(content.length, offset + after);
  console.log(`\n=== ${label} (offset=${offset}, range=${start}..${end}) ===`);
  console.log(content.slice(start, end));
}

// 1. skey usage in 8d5f508b6da3
snippet(c1, 31116, 800, 1200, 'skey usage in 8d5f508b6da3 (full context)');
// 2. resource_url extraction in 8d5f508b6da3
snippet(c1, 30961, 200, 200, 'resource_url extraction');

// 3. Look for "image" or "build_image" related code in this file
const imageIdx = c1.indexOf('build_image');
if (imageIdx >= 0) snippet(c1, imageIdx, 200, 400, 'build_image in 8d5f508b6da3');

// 4. Look for "/aweme/v1/web/im" API calls
let idx = 0;
let count = 0;
while ((idx = c1.indexOf('/aweme/v1/web/im', idx)) >= 0 && count < 10) {
  snippet(c1, idx, 100, 300, `/aweme/v1/web/im at ${idx}`);
  idx++;
  count++;
}

// 5. Look for "encrypt" in this file
idx = 0; count = 0;
while ((idx = c1.toLowerCase().indexOf('encrypt', idx)) >= 0 && count < 5) {
  snippet(c1, idx, 150, 200, `encrypt at ${idx}`);
  idx++;
  count++;
}

// 6. Decode protobuf: CgYIASAHKAESrw0K (base64)
console.log('\n\n========== PROTOBUF DECODE ==========');
const b64 = 'CgYIASAHKAESrw0K';
const buf = Buffer.from(b64, 'base64');
console.log('Base64:', b64);
console.log('Hex:', buf.toString('hex'));
console.log('Bytes:', Array.from(buf));
console.log('Length:', buf.length, 'bytes');

// Manual protobuf decode
function decodeProtobuf(buf, indent) {
  indent = indent || '';
  let i = 0;
  while (i < buf.length) {
    const startOffset = i;
    // Read tag (varint)
    let tag = 0;
    let shift = 0;
    while (i < buf.length) {
      const b = buf[i++];
      tag += (b & 0x7f) * Math.pow(2, shift);
      if ((b & 0x80) === 0) break;
      shift += 7;
      if (shift > 35) { console.log(`${indent}  [varint overflow]`); return; }
    }
    const fieldNum = Math.floor(tag / 8);
    const wireType = tag % 8;
    let valStr;
    if (wireType === 0) {
      // varint
      let v = 0; let s = 0;
      while (i < buf.length) {
        const b = buf[i++];
        v += (b & 0x7f) * Math.pow(2, s);
        if ((b & 0x80) === 0) break;
        s += 7;
      }
      valStr = `varint=${v}`;
    } else if (wireType === 1) {
      // 64-bit
      const v = buf.slice(i, i+8);
      i += 8;
      valStr = `64bit=${v.toString('hex')}`;
    } else if (wireType === 2) {
      // length-delimited
      let len = 0; let s = 0;
      while (i < buf.length) {
        const b = buf[i++];
        len += (b & 0x7f) * Math.pow(2, s);
        if ((b & 0x80) === 0) break;
        s += 7;
      }
      const v = buf.slice(i, i+len);
      i += len;
      // Try utf-8
      let utf8 = '';
      try {
        const s = v.toString('utf-8');
        if (/^[\x20-\x7e]+$/.test(s)) utf8 = ` utf8="${s}"`;
      } catch {}
      valStr = `len=${len} hex=${v.toString('hex')}${utf8}`;
      // Try recursive
      if (len > 0) {
        console.log(`${indent}field ${fieldNum} (wire=2, offset=${startOffset}): ${valStr}`);
        decodeProtobuf(v, indent + '  ');
        continue;
      }
    } else if (wireType === 5) {
      // 32-bit
      const v = buf.slice(i, i+4);
      i += 4;
      valStr = `32bit=${v.toString('hex')}`;
    } else {
      valStr = `[unsupported wire ${wireType}]`;
      i = buf.length;
    }
    console.log(`${indent}field ${fieldNum} (wire=${wireType}, offset=${startOffset}): ${valStr}`);
  }
}

decodeProtobuf(buf, '');

// Also try the full string with potential padding
console.log('\n--- Try with CgYIASAHKAESrw0K=== padding ---');
const padded = b64 + '===';
const buf2 = Buffer.from(padded, 'base64');
console.log('Hex:', buf2.toString('hex'));
decodeProtobuf(buf2, '');
