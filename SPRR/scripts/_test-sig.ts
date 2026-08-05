/**
 * 详细打印当前 Node.js 实现的 payload 结构
 */
import { generateABogus } from '../src/crypto/abogus.js';

const sig = generateABogus({
  url: '/aweme/v1/web/im/notice/',
  params: { notice_group: '960' },
  method: 'GET',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
});
console.log('SIG:', sig);
console.log('LEN:', sig.length);

// Decode the output to see structure
const S4_TABLE = 'Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe';
const RC4_KEY = 0xd3;
const MASK_A = 0b10010001, MASK_B = 0b01101110, MASK_C = 0b01000010, MASK_D = 0b10111101, MASK_E = 0b00101100, MASK_F = 0b11010011;

function customBase64Decode(s: string, table: string): Uint8Array {
  // S4 table already contains - and _ as native chars, do NOT replace them
  const padding = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const core = padding > 0 ? s.slice(0, -padding) : s;
  const out: number[] = [];
  for (let i = 0; i < core.length; i += 4) {
    const c0 = table.indexOf(core[i]);
    const c1 = table.indexOf(core[i + 1]);
    const c2 = i + 2 < core.length ? table.indexOf(core[i + 2]) : -1;
    const c3 = i + 3 < core.length ? table.indexOf(core[i + 3]) : -1;
    if (c0 < 0 || c1 < 0) break;
    out.push((c0 << 2) | (c1 >> 4));
    if (c2 >= 0) {
      out.push(((c1 & 0xf) << 4) | (c2 >> 2));
      if (c3 >= 0) {
        out.push(((c2 & 0x3) << 6) | c3);
      }
    }
  }
  return new Uint8Array(out);
}

function rc4Variant(key: number[], data: Uint8Array): Uint8Array {
  const len = key.length;
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = 255 - i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j * S[i] + j + key[i % len]) % 256;
    const tmp = S[i];
    S[i] = S[j];
    S[j] = tmp;
  }
  const out = new Uint8Array(data.length);
  let i2 = 0; j = 0;
  for (let k = 0; k < data.length; k++) {
    i2 = (i2 + 1) % 256;
    j = (j + S[i2]) % 256;
    const tmp = S[i2]; S[i2] = S[j]; S[j] = tmp;
    const t = (S[i2] + S[j]) % 256;
    out[k] = data[k] ^ S[t];
  }
  return out;
}

function ungarble3to4(garbled: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < garbled.length; i += 4) {
    const o0 = garbled[i], o1 = garbled[i + 1], o2 = garbled[i + 2], o3 = garbled[i + 3];
    out.push((o0 & MASK_B) | (o3 & MASK_A), (o1 & MASK_D) | (o3 & MASK_C), (o2 & MASK_F) | (o3 & MASK_E));
  }
  return new Uint8Array(out);
}

const decoded = customBase64Decode(sig, S4_TABLE);
console.log('\n=== Decoded structure ===');
console.log('Total bytes:', decoded.length);
const prefix = decoded.slice(0, 4);
const rc4Input = decoded.slice(4);
const decrypted = rc4Variant([RC4_KEY], rc4Input);
const versionGarbled = decrypted.slice(0, 8);
const garbledPayload = decrypted.slice(8);
const payload = ungarble3to4(garbledPayload);
console.log('Payload length:', payload.length);
console.log('Payload hex:');
for (let i = 0; i < payload.length; i += 16) {
  const slice = payload.slice(i, Math.min(i + 16, payload.length));
  const hex = Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' ');
  const ascii = Array.from(slice).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
  console.log(`  [${i.toString().padStart(2)}] ${hex.padEnd(48)} ${ascii}`);
}
