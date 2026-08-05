/**
 * 一次性脚本：解码关键抓包样本的 field 8 body 嵌套 message
 * 用于确认 list/history 接口的 body 字段号
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  parseFields,
  readString,
  readVarint,
  readMessage,
  findField,
} from '../src/crypto/protobuf.js';

async function decodeCapture(file: string) {
  const raw = await fs.readFile(file, 'utf-8');
  const j = JSON.parse(raw);
  const b64 = j.request.bodyBase64;
  if (!b64) {
    console.log(`[${file}] no bodyBase64`);
    return;
  }
  const buf = Buffer.from(b64, 'base64');
  console.log(`\n=== ${path.basename(file)} (bodySize=${buf.length}) ===`);
  const fields = parseFields(buf);
  for (const f of fields) {
    if (f.wire === 0) {
      console.log(`  field ${f.field} (varint): ${readVarint(f)}`);
    } else if (f.wire === 2) {
      const s = readString(f);
      if (s && /^[\x20-\x7e]+$/.test(s.slice(0, 20))) {
        console.log(`  field ${f.field} (string): ${JSON.stringify(s.slice(0, 80))}`);
      } else {
        // 可能是嵌套 message
        const sub = readMessage(f);
        if (sub.length > 0) {
          console.log(`  field ${f.field} (message, ${sub.length} sub-fields):`);
          for (const sf of sub) {
            if (sf.wire === 0) {
              console.log(`    sub field ${sf.field} (varint): ${readVarint(sf)}`);
            } else if (sf.wire === 2) {
              const ss = readString(sf);
              if (ss && /^[\x20-\x7e]+$/.test(ss.slice(0, 20))) {
                console.log(`    sub field ${sf.field} (string): ${JSON.stringify(ss.slice(0, 80))}`);
              } else {
                const ssub = readMessage(sf);
                if (ssub.length > 0) {
                  console.log(`    sub field ${sf.field} (nested, ${ssub.length} fields)`);
                  for (const ssf of ssub) {
                    if (ssf.wire === 0) {
                      console.log(`      sub.sub field ${ssf.field} (varint): ${readVarint(ssf)}`);
                    } else if (ssf.wire === 2) {
                      const sss = readString(ssf);
                      console.log(
                        `      sub.sub field ${ssf.field} (string): ${JSON.stringify(sss.slice(0, 80))}`,
                      );
                    }
                  }
                } else {
                  console.log(
                    `    sub field ${sf.field} (bytes, ${(sf.value as Buffer).length}B): ${(
                      sf.value as Buffer
                    )
                      .toString('hex')
                      .slice(0, 60)}`,
                  );
                }
              }
            }
          }
        } else {
          console.log(
            `  field ${f.field} (bytes, ${(f.value as Buffer).length}B): ${(f.value as Buffer)
              .toString('hex')
              .slice(0, 60)}`,
          );
        }
      }
    }
  }

  // 解码 response
  if (j.response?.bodyBase64) {
    const rBuf = Buffer.from(j.response.bodyBase64, 'base64');
    console.log(`  --- response (size=${rBuf.length}) ---`);
    const rFields = parseFields(rBuf);
    for (const f of rFields) {
      if (f.wire === 0) {
        console.log(`  resp field ${f.field} (varint): ${readVarint(f)}`);
      } else if (f.wire === 2) {
        const s = readString(f);
        if (s && /^[\x20-\x7e]+$/.test(s.slice(0, 20))) {
          console.log(`  resp field ${f.field} (string): ${JSON.stringify(s.slice(0, 80))}`);
        } else {
          const sub = readMessage(f);
          console.log(
            `  resp field ${f.field} (${sub.length > 0 ? 'message' : 'bytes'}, ${
              (f.value as Buffer).length
            }B)`,
          );
          if (sub.length > 0 && (f.field === 6 || f.field === 8)) {
            for (const sf of sub.slice(0, 10)) {
              if (sf.wire === 0) {
                console.log(`    rsub field ${sf.field} (varint): ${readVarint(sf)}`);
              } else if (sf.wire === 2) {
                const ss = readString(sf);
                console.log(
                  `    rsub field ${sf.field} (${/^[\x20-\x7e]+$/.test(ss.slice(0, 20)) ? 'string' : 'bytes'}): ${JSON.stringify(ss.slice(0, 80))}`,
                );
              }
            }
            if (sub.length > 10) console.log(`    ... (${sub.length - 10} more)`);
          }
        }
      }
    }
  }
}

const BASE = 'd:\\Desktop\\DYCC\\SPRR\\data\\capture\\categorized';
const targets = [
  path.join(BASE, 'fetch_messages', '0272_POST_21ff6b80a2d9.json'),
  path.join(BASE, 'fetch_messages', '0285_POST_21ff6b80a2d9.json'),
  path.join(BASE, 'stranger_list', '0226_POST_eb0efa4e8533.json'),
  path.join(BASE, 'conversation_info', '0270_POST_f862efc3c3bb.json'),
  path.join(BASE, 'send_message', '0318_POST_1b4cc70404cb.json'),
];

for (const t of targets) {
  await decodeCapture(t);
}
