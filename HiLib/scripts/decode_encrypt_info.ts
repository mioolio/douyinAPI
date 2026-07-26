const b64 = 'CgYIASAHKAESnw0KnA1cJQ3C92Lbx54oEwjT6/nSa9smyrbaeUcIJopMimKwzWn1FZVC6dKtF3oz5y+X3iq1Y5ng1pXFR4/H1s/M2EY5z9jfLrzKwxlvobbpVEI9KyE6nISMbVh56UuII30xmbboIb6c8ojt4BaYq3ExrimIKHWV0gRtNAZKPVEZ4rZ4R+siyPuP/5CG';
const buf = Buffer.from(b64, 'base64');
console.log('总长度:', buf.length);
console.log('前 40 字节 hex:', buf.subarray(0, 40).toString('hex'));

function readVarint(buf: Buffer, start: number): { value: number; next: number } | null {
  let result = 0, shift = 0, i = start;
  while (i < buf.length) {
    const b = buf[i++];
    result += (b & 0x7f) * Math.pow(2, shift);
    if ((b & 0x80) === 0) return { value: result, next: i };
    shift += 7;
    if (shift > 63) return null;
  }
  return null;
}

let i = 0;
let fieldNum = 0;
while (i < buf.length && fieldNum < 10) {
  const tag = readVarint(buf, i);
  if (!tag) break;
  i = tag.next;
  const field = Math.floor(tag.value / 8);
  const wire = tag.value % 8;
  process.stdout.write(`field ${field} wire ${wire}\n`);
  if (wire === 2) {
    const lenV = readVarint(buf, i);
    if (!lenV) break;
    i = lenV.next;
    const sub = buf.subarray(i, i + lenV.value);
    process.stdout.write(`  length ${lenV.value} hex(前60): ${sub.subarray(0, 60).toString('hex')}\n`);
    // 尝试递归解析为 protobuf
    try {
      let j = 0;
      let subFieldNum = 0;
      while (j < sub.length && subFieldNum < 6) {
        const subTag = readVarint(sub, j);
        if (!subTag) break;
        j = subTag.next;
        const sf = Math.floor(subTag.value / 8);
        const sw = subTag.value % 8;
        process.stdout.write(`  sub-field ${sf} wire ${sw}`);
        if (sw === 2) {
          const sl = readVarint(sub, j);
          if (!sl) { process.stdout.write('\n'); break; }
          j = sl.next;
          const ss = sub.subarray(j, j + sl.value);
          process.stdout.write(` len=${sl.value} hex=${ss.subarray(0, 40).toString('hex')}`);
          // 尝试 utf-8
          const text = ss.toString('utf-8');
          if (/^[\x20-\x7e]+$/.test(text) && text.length > 0) {
            process.stdout.write(` utf8="${text.slice(0, 100)}"`);
          }
          j += sl.value;
        } else if (sw === 0) {
          const sv = readVarint(sub, j);
          if (!sv) { process.stdout.write('\n'); break; }
          process.stdout.write(` value=${sv.value}`);
          j = sv.next;
        } else {
          process.stdout.write(' unknown');
          break;
        }
        process.stdout.write('\n');
        subFieldNum++;
      }
    } catch (e) {
      process.stdout.write(`  (sub-parse failed: ${e})\n`);
    }
    i += lenV.value;
  } else if (wire === 0) {
    const v = readVarint(buf, i);
    if (!v) break;
    process.stdout.write(`  value ${v.value}\n`);
    i = v.next;
  } else {
    process.stdout.write(`  unknown wire ${wire}\n`);
    break;
  }
  fieldNum++;
}
