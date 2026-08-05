/**
 * 临时探索脚本：检查 read_index/min_index/batch_readindex/im_user_info 端点
 */
import fs from 'node:fs/promises';
import {
  parseFields,
  readString,
  readVarint,
  readMessage,
  findField,
  findFields,
} from '../src/crypto/protobuf.js';

async function decode(file: string) {
  const j = JSON.parse(await fs.readFile(file, 'utf-8'));
  console.log(`\n=== ${file.split(/[\\/]/).pop()} ===`);
  console.log('URL:', j.request.url);
  console.log('bodySize:', j.request.bodySize);

  if (j.request.bodyBase64) {
    const buf = Buffer.from(j.request.bodyBase64, 'base64');
    const fields = parseFields(buf);
    const cmd = findField(fields, 1) ? readVarint(findField(fields, 1)!) : 0;
    const seq = findField(fields, 2) ? readVarint(findField(fields, 2)!) : 0;
    const it = findField(fields, 6) ? readVarint(findField(fields, 6)!) : 0;
    console.log(`req cmd=${cmd} seq=${seq} inbox_type=${it}`);
    const bodyField = findField(fields, 8);
    if (bodyField) {
      const sub = readMessage(bodyField);
      console.log(`field 8 sub-fields count: ${sub.length}`);
      for (const sf of sub) {
        console.log(`  sub field ${sf.field} wire ${sf.wire}`);
        if (sf.wire === 2) {
          const sss = readString(sf);
          if (sss && /^[\x20-\x7e]+$/.test(sss.slice(0, 20)))
            console.log(`    string: ${JSON.stringify(sss.slice(0, 80))}`);
          const nested = readMessage(sf);
          if (nested.length > 0) {
            console.log(`    nested ${nested.length} fields:`);
            for (const n of nested.slice(0, 10)) {
              if (n.wire === 0) console.log(`      field ${n.field} varint ${readVarint(n)}`);
              else if (n.wire === 2) {
                const sn = readString(n);
                console.log(
                  `      field ${n.field} ${/^[\x20-\x7e]+$/.test(sn.slice(0, 20)) ? 'string' : 'bytes'}: ${JSON.stringify(sn.slice(0, 60))}`,
                );
              }
            }
          }
        }
      }
    }
  }

  if (j.response?.bodyBase64) {
    const rBuf = Buffer.from(j.response.bodyBase64, 'base64');
    const rFields = parseFields(rBuf);
    const rCmd = findField(rFields, 1) ? readVarint(findField(rFields, 1)!) : 0;
    const rStatus = findField(rFields, 3) ? readVarint(findField(rFields, 3)!) : 0;
    console.log(`resp cmd=${rCmd} status=${rStatus} size=${rBuf.length}`);
    const rBody = findField(rFields, 6);
    if (rBody) {
      const rSub = readMessage(rBody);
      console.log(`resp body sub-fields count: ${rSub.length}`);
      for (const sf of rSub.slice(0, 5)) {
        console.log(`  rsub field ${sf.field} wire ${sf.wire} len ${sf.length}`);
        if (sf.wire === 2) {
          const nested = readMessage(sf);
          if (nested.length > 0) {
            console.log(`    nested ${nested.length} fields:`);
            for (const n of nested.slice(0, 10)) {
              if (n.wire === 0) console.log(`      field ${n.field} varint ${readVarint(n)}`);
              else if (n.wire === 2) {
                const sn = readString(n);
                console.log(
                  `      field ${n.field} ${/^[\x20-\x7e]+$/.test(sn.slice(0, 20)) ? 'string' : 'bytes'}: ${JSON.stringify(sn.slice(0, 60))}`,
                );
              }
            }
          } else {
            console.log(`    raw: ${(sf.value as Buffer).toString('hex').slice(0, 100)}`);
          }
        }
      }
    }
  }
}

const files = [
  'data/capture/categorized/read_index/0289_POST_c142f6dafac6.json',
  'data/capture/categorized/min_index/0292_POST_3374411eeb97.json',
  'data/capture/categorized/batch_readindex/0270_POST_69146b4e0764.json',
  'data/capture/categorized/im_user_info/0228_POST_3e12f57af089.json',
];

for (const f of files) {
  await decode(f);
}
