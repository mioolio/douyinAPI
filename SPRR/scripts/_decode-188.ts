/**
 * 详细解码真实浏览器 a_bogus (188 字符)
 * 输出每字节的详细分析
 */
import { readFileSync } from 'fs';

const data = JSON.parse(readFileSync('d:/Desktop/DYCC/SPRR/data/probe-xhr-hook.json', 'utf-8'));
const requests = data.finalRequests as Array<{ url: string }>;

// Find the notice API request (188 chars)
const noticeReq = requests.find(r => r.url.includes('a_bogus=') && r.url.includes('notice/'));
if (!noticeReq) throw new Error('not found');
const u = new URL(noticeReq.url);
const aBogus = u.searchParams.get('a_bogus')!;

const S4_TABLE = 'Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe';
const RC4_KEY = 0xd3;
const MASK_A = 0b10010001, MASK_B = 0b01101110, MASK_C = 0b01000010, MASK_D = 0b10111101, MASK_E = 0b00101100, MASK_F = 0b11010011;
const MASK_AA = 0xaa, MASK_55 = 0x55;

function customBase64Decode(s: string, table: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    const c0 = table.indexOf(s[i]);
    const c1 = table.indexOf(s[i + 1]);
    const c2 = i + 2 < s.length ? table.indexOf(s[i + 2]) : -1;
    const c3 = i + 3 < s.length ? table.indexOf(s[i + 3]) : -1;
    if (c0 < 0 || c1 < 0) break;
    out.push((c0 << 2) | (c1 >> 4));
    if (c2 >= 0) {
      out.push(((c1 & 0xf) << 4) | (c2 >> 2));
      if (c3 >= 0) out.push(((c2 & 0x3) << 6) | c3);
    }
  }
  return new Uint8Array(out);
}

function rc4Variant(key: number[], data: Uint8Array): Uint8Array {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = 255 - i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j * S[i] + j + key[i % key.length]) % 256;
    [S[i], S[j]] = [S[j], S[i]];
  }
  const out = new Uint8Array(data.length);
  let i2 = 0; j = 0;
  for (let k = 0; k < data.length; k++) {
    i2 = (i2 + 1) % 256;
    j = (j + S[i2]) % 256;
    [S[i2], S[j]] = [S[j], S[i2]];
    const t = (S[i2] + S[j]) % 256;
    out[k] = data[k] ^ S[t];
  }
  return out;
}

function ungarble3to4(garbled: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < garbled.length; i += 4) {
    out.push(
      (garbled[i] & MASK_B) | (garbled[i + 3] & MASK_A),
      (garbled[i + 1] & MASK_D) | (garbled[i + 3] & MASK_C),
      (garbled[i + 2] & MASK_F) | (garbled[i + 3] & MASK_E),
    );
  }
  return new Uint8Array(out);
}

function toHex(buf: Uint8Array): string {
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join(' ');
}
function toAscii(buf: Uint8Array): string {
  return Array.from(buf).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
}

const decoded = customBase64Decode(aBogus, S4_TABLE);
console.log('=== Total decoded bytes:', decoded.length);
const prefix = decoded.slice(0, 4);
const rc4Input = decoded.slice(4);
const decrypted = rc4Variant([RC4_KEY], rc4Input);
const versionGarbled = decrypted.slice(0, 8);
const garbledPayload = decrypted.slice(8);
const payload = ungarble3to4(garbledPayload);
console.log('Payload bytes:', payload.length);
console.log('Payload hex:');
for (let i = 0; i < payload.length; i += 16) {
  const slice = payload.slice(i, Math.min(i + 16, payload.length));
  const hex = toHex(slice).padEnd(48);
  const ascii = toAscii(slice);
  console.log(`  [${i.toString().padStart(3)}] ${hex} | ${ascii}`);
}

// Find "1400" substring
const deviceStr = '1400|900|1416|988|1400|900|1400|900|Win32';
const ascii = toAscii(payload);
const deviceIdx = ascii.indexOf('1400');
console.log(`\nDevice info "1400..." starts at byte: ${deviceIdx}`);
const timeIdx = ascii.indexOf('237,');
console.log(`Time encoding "237," starts at byte: ${timeIdx}`);

// Show bytes before "1400"
const before = payload.slice(0, deviceIdx);
console.log(`\n=== Bytes BEFORE device info (${before.length} bytes) ===`);
console.log('Hex:', toHex(before));
console.log('Ascii:', toAscii(before));

// Show device info
const deviceBytes = payload.slice(deviceIdx, timeIdx);
console.log(`\n=== Device info (${deviceBytes.length} bytes) ===`);
console.log('Hex:', toHex(deviceBytes));
console.log('Ascii:', toAscii(deviceBytes));

// Show time encoding
const timeBytes = payload.slice(timeIdx);
console.log(`\n=== Time encoding + checksum (${timeBytes.length} bytes) ===`);
console.log('Hex:', toHex(timeBytes));
console.log('Ascii:', toAscii(timeBytes));

// Try different fixed sizes
console.log('\n=== Trying different fixed field sizes ===');
for (const fixedSize of [4, 6, 8, 10, 12, 16, 20, 24, 25, 26, 28]) {
  const fixed = payload.slice(0, fixedSize);
  const rest = payload.slice(fixedSize);
  const hex = toHex(fixed);
  const ascii = toAscii(fixed);
  console.log(`  [${fixedSize}] ${hex}  | ${ascii}`);
}
