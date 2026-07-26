// 最终提取脚本：从 e445 中提取关键代码片段，并正确解析 protobuf
const fs = require('fs');

const e445 = fs.readFileSync('D:/Desktop/DYCC/SPRR/data/capture/js/e445bc994f58___federation_expose_default_export.d40e64ca.js', 'utf8');
const w3530 = fs.readFileSync('D:/Desktop/DYCC/SPRR/data/capture/js/f9427dab3065_3530.a56b2fb0.js', 'utf8');

function extractContext(text, pattern, before=80, after=200) {
  const idx = text.search(pattern);
  if (idx === -1) return null;
  return text.substring(Math.max(0, idx-before), idx+after);
}

console.log('=== e445: read_once/detail ===');
console.log(extractContext(e445, /read_once\/detail/, 50, 250));

console.log('\n=== e445: imageDecryptor ===');
console.log(extractContext(e445, /imageDecryptor/, 80, 200));

console.log('\n=== e445: aes-256-gcm ===');
console.log(extractContext(e445, /aes-256-gcm/, 30, 200));

console.log('\n=== e445: batch_build_image ===');
console.log(extractContext(e445, /batch_build_image/, 50, 250));

console.log('\n=== e445: large_url_list ===');
console.log(extractContext(e445, /large_url_list/, 80, 200));

console.log('\n=== e445: show_once_info ===');
console.log(extractContext(e445, /show_once_info/, 50, 200));

console.log('\n=== 3530 worker: AES-GCM importKey ===');
console.log(extractContext(w3530, /importKey/, 60, 200));

console.log('\n=== 3530 worker: slice(12) ===');
console.log(extractContext(w3530, /slice\(12\)/, 80, 150));

console.log('\n=== 3530 worker: skey match ===');
console.log(extractContext(w3530, /skey/, 50, 150));

console.log('\n=== 正确的 protobuf 解析 ===');
const buf = Buffer.from('CgYIASAHKAESrw0K', 'base64');
console.log('hex:', buf.toString('hex'));
console.log('bytes:', Array.from(buf).join(', '));

// 正确的 varint 解析
function readVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  do {
    const b = buf[offset];
    result |= BigInt(b & 0x7f) << shift;
    shift += 7n;
    offset++;
  } while (buf[offset-1] & 0x80);
  return { value: result, offset };
}

let off = 0;
while (off < buf.length) {
  const tagByte = buf[off]; off++;
  const field = tagByte >> 3;
  const wt = tagByte & 7;
  if (wt === 0) {
    const v = readVarint(buf, off);
    console.log(`field ${field} (varint): ${v.value}`);
    off = v.offset;
  } else if (wt === 2) {
    const v = readVarint(buf, off);
    off = v.offset;
    const len = Number(v.value);
    const data = buf.slice(off, Math.min(off + len, buf.length));
    console.log(`field ${field} (bytes): len=${len}, actual=${data.length}, hex=${data.toString('hex')}, utf8=${JSON.stringify(data.toString('utf8'))}`);
    if (len > data.length) console.log(`   长度声明 ${len} 但实际只有 ${data.length} 字节，base64 被截断！`);
    // 如果是嵌套消息，尝试解析
    if (field === 1 && data.length >= 2) {
      let subOff = 0;
      while (subOff < data.length) {
        const subTag = data[subOff]; subOff++;
        const subField = subTag >> 3;
        const subWt = subTag & 7;
        if (subWt === 0) {
          const sv = readVarint(data, subOff);
          console.log(`  sub-field ${subField} (varint): ${sv.value}`);
          subOff = sv.offset;
        } else { break; }
      }
    }
    off += len;
  } else {
    console.log(`field ${field} (wt=${wt}): unsupported`);
    break;
  }
}
