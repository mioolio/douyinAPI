/**
 * 详细解码 notice/ a_bogus payload
 */
import { readFileSync } from 'fs';

const S4_TABLE = 'Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe';
const RC4_KEY = 0xd3;

const MASK_A = 0b10010001;
const MASK_B = 0b01101110;
const MASK_C = 0b01000010;
const MASK_D = 0b10111101;
const MASK_E = 0b00101100;
const MASK_F = 0b11010011;
const MASK_AA = 0xaa;
const MASK_55 = 0x55;

function customBase64Decode(s: string, table: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
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
  let i2 = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i2 = (i2 + 1) % 256;
    j = (j + S[i2]) % 256;
    const tmp = S[i2];
    S[i2] = S[j];
    S[j] = tmp;
    const t = (S[i2] + S[j]) % 256;
    out[k] = data[k] ^ S[t];
  }
  return out;
}

function ungarble3to4(garbled: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < garbled.length; i += 4) {
    const o0 = garbled[i], o1 = garbled[i + 1], o2 = garbled[i + 2], o3 = garbled[i + 3];
    const d0 = (o0 & MASK_B) | (o3 & MASK_A);
    const d1 = (o1 & MASK_D) | (o3 & MASK_C);
    const d2 = (o2 & MASK_F) | (o3 & MASK_E);
    out.push(d0, d1, d2);
  }
  return new Uint8Array(out);
}

const aBogus = 'mJ4RD7S7OpARFdMSuOG5tHMUkX6lNBSjQeixbwBP7PTrPXMaJYNSKxS/nxzz4g5fbYB0kFIHtxzMYxxcYzUsZo9pumkkSTtR5t2InWsogqq6GzksLqbhCLmzKwBC0QvEa5nUNA7R1sMrIxclVqAiApAa75F9QQYpbrMWd2TyGDS03PLT9oQ1eVuACH6=';

console.log('a_bogus length:', aBogus.length);

const decoded = customBase64Decode(aBogus, S4_TABLE);
console.log('After s4 decode:', decoded.length, 'bytes');
console.log('hex:', Array.from(decoded).map(b => b.toString(16).padStart(2, '0')).join(' '));

const prefix = decoded.slice(0, 4);
const rc4Input = decoded.slice(4);
console.log('prefix:', Array.from(prefix).map(b => b.toString(16).padStart(2, '0')).join(' '));

const decrypted = rc4Variant([RC4_KEY], rc4Input);
console.log('After RC4:', decrypted.length, 'bytes');

const versionGarbled = decrypted.slice(0, 8);
const garbledPayload = decrypted.slice(8);
console.log('version garbled:', Array.from(versionGarbled).map(b => b.toString(16).padStart(2, '0')).join(' '));
console.log('garbled payload length:', garbledPayload.length);

const payload = ungarble3to4(garbledPayload);
console.log('After ungarble3to4:', payload.length, 'bytes');
console.log('full payload hex:');
for (let i = 0; i < payload.length; i += 16) {
  const slice = payload.slice(i, Math.min(i + 16, payload.length));
  const hex = Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' ');
  const ascii = Array.from(slice).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
  console.log(`  [${i.toString().padStart(2)}] ${hex.padEnd(48)} ${ascii}`);
}
