/**
 * 抖音 a_bogus 纯算构造（bdms V 1.0.1.19-fix.01 逆向）
 *
 * 参考：https://haloowhite.com/2026/04/15/dy-abogus-pure-algorithm/
 *
 * 算法链路：
 *   1. SM3 二次哈希（盐值 "dhzx"）→ url_hash / body_hash
 *   2. UA 经 s3 表 Base64 编码后 SM3 单次哈希 → ua_hash
 *   3. 组装 payload（固定域 + 可变域 + XOR 校验和）
 *   4. 位掩码扩展 garble_3to4（3 字节 → 4 字节，注入随机）
 *   5. RC4 变体加密（key=0xD3，反转 S-box，修改版 KSA）
 *   6. 自定义 Base64 编码（s4 表）→ 192 字符 a_bogus
 *
 * 常量来源：bdms.js JSVMP 字节码 Z 常量池
 *   - dhzx @ Z[262]
 *   - s3 表 @ Z[253]（UA 预处理 Base64，含 +）
 *   - s4 表 @ Z[255]（最终输出 Base64，URL-safe 含 -）
 */

/* ============================== 常量 ============================== */

/** SM3 双重哈希盐值（Z[262]） */
const SALT = 'dhzx';

/** UA 预处理 Base64 编码表（Z[253]，含 +） */
const S3_TABLE = 'ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe';

/** a_bogus 最终输出 Base64 编码表（Z[255]，URL-safe 含 -） */
const S4_TABLE = 'Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe';

/** 位掩码扩展常量（3 组互补掩码） */
const MASK_A = 0b10010001; // 145
const MASK_B = 0b01101110; // 110  (A|B = 255)
const MASK_C = 0b01000010; // 66
const MASK_D = 0b10111101; // 189  (C|D = 255)
const MASK_E = 0b00101100; // 44
const MASK_F = 0b11010011; // 211  (E|F = 255)

/** 版本号掩码 */
const MASK_AA = 0xaa;
const MASK_55 = 0x55;

/** RC4 变体密钥 */
const RC4_KEY = 0xd3;

/** 固定 magic 值 */
const MAGIC = 41;

/* ============================== SM3 哈希 ============================== */
/* GB/T 32905-2016 国密 SM3 密码杂凑算法
 * 初始 IV: 0x7380166f 0x4914b2b9 0x172442d7 0xda8a0600
 *          0xa96f30bc 0x163138aa 0xe38dee4d 0xb0fb0e4e
 * 输出 32 字节 (256 位) 摘要
 *
 * 参考文章明确说明识别 SM3 的方式：
 *   "看初始向量 0x7380166f 开头就是 SM3"
 * 与 sm-crypto 实现一致。
 */
const SM3_IV = new Uint32Array([
  0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600,
  0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e,
]);

/** SM3 逻辑位运算辅助 (32-bit 无符号) */
const rotl32 = (x: number, n: number): number => {
  x = x >>> 0;
  n = n & 31;
  return ((x << n) | (x >>> (32 - n))) >>> 0;
};

/** SM3 P0 置换函数（用于压缩函数: E = P0(TT2)） */
const p0 = (x: number): number => (x ^ rotl32(x, 9) ^ rotl32(x, 17)) >>> 0;

/** SM3 P1 置换函数（用于消息扩展: W[i] = P1(...)） */
const p1 = (x: number): number => (x ^ rotl32(x, 15) ^ rotl32(x, 23)) >>> 0;

/** SM3 FF 函数 */
const ff = (j: number, a: number, b: number, c: number): number => {
  if (j >= 0 && j <= 15) return (a ^ b ^ c) >>> 0;
  return ((a & b) | (a & c) | (b & c)) >>> 0;
};

/** SM3 GG 函数 */
const gg = (j: number, a: number, b: number, c: number): number => {
  if (j >= 0 && j <= 15) return (a ^ b ^ c) >>> 0;
  return ((a & b) | (~a & c)) >>> 0;
};

/** SM3 常量 T */
const tT = (j: number): number => {
  if (j >= 0 && j <= 15) return 0x79cc4519;
  return 0x7a879d8a;
};

/** SM3 消息扩展 (W, W') */
function sm3Expand(B: Uint8Array): { W: Uint32Array; Wp: Uint32Array } {
  const W = new Uint32Array(68);
  const Wp = new Uint32Array(64);
  // 前 16 个字：直接从分组取
  for (let i = 0; i < 16; i++) {
    W[i] = ((B[i * 4] << 24) | (B[i * 4 + 1] << 16) | (B[i * 4 + 2] << 8) | B[i * 4 + 3]) >>> 0;
  }
  // 后续 52 个字
  for (let i = 16; i < 68; i++) {
    const val = (p1(W[i - 16] ^ W[i - 9] ^ rotl32(W[i - 3], 15)) ^ rotl32(W[i - 13], 7) ^ W[i - 6]) >>> 0;
    W[i] = val;
  }
  // W' = W[i] ^ W[i+4]
  for (let i = 0; i < 64; i++) {
    Wp[i] = (W[i] ^ W[i + 4]) >>> 0;
  }
  return { W, Wp };
}

/** SM3 压缩函数 CF */
function sm3CF(V: Uint32Array, B: Uint8Array): Uint32Array {
  const { W, Wp } = sm3Expand(B);
  const T = new Uint32Array([
    V[0] >>> 0, V[1] >>> 0, V[2] >>> 0, V[3] >>> 0,
    V[4] >>> 0, V[5] >>> 0, V[6] >>> 0, V[7] >>> 0,
  ]);
  let A = T[0], Bb = T[1], C = T[2], D = T[3];
  let E = T[4], F = T[5], G = T[6], H = T[7];

  for (let j = 0; j < 64; j++) {
    const tmp = (rotl32(A, 12) + E + rotl32(tT(j), j % 32)) >>> 0;
    const SS1 = rotl32(tmp, 7);
    const SS2 = (SS1 ^ rotl32(A, 12)) >>> 0;
    const TT1 = (ff(j, A, Bb, C) + D + SS2 + Wp[j]) >>> 0;
    const TT2 = (gg(j, E, F, G) + H + SS1 + W[j]) >>> 0;
    D = C;
    C = rotl32(Bb, 9);
    Bb = A;
    A = TT1;
    H = G;
    G = rotl32(F, 19);
    F = E;
    E = p0(TT2);
  }

  return new Uint32Array([
    (A ^ V[0]) >>> 0, (Bb ^ V[1]) >>> 0, (C ^ V[2]) >>> 0, (D ^ V[3]) >>> 0,
    (E ^ V[4]) >>> 0, (F ^ V[5]) >>> 0, (G ^ V[6]) >>> 0, (H ^ V[7]) >>> 0,
  ]);
}

/** 计算 SM3 摘要，返回 32 字节 Uint8Array */
export function sm3(data: Uint8Array): Uint8Array {
  // 填充：追加 0x80，再追加 0x00 直到长度 ≡ 56 (mod 64)，最后追加 8 字节长度（bit 长度，big-endian）
  const bitLen = BigInt(data.length) * 8n;
  const padLen = (data.length + 1 + 8) % 64 === 0
    ? data.length + 1 + 8
    : data.length + 1 + 8 + (64 - ((data.length + 1 + 8) % 64));
  const padded = new Uint8Array(padLen);
  padded.set(data);
  padded[data.length] = 0x80;
  // 末尾 8 字节为 bit 长度 big-endian
  const dv = new DataView(padded.buffer);
  dv.setUint32(padLen - 8, Number(bitLen >> 32n));
  dv.setUint32(padLen - 4, Number(bitLen & 0xffffffffn));

  let V = SM3_IV.slice();
  const blocks = Math.floor(padLen / 64);
  for (let i = 0; i < blocks; i++) {
    const block = padded.subarray(i * 64, (i + 1) * 64);
    V = sm3CF(V, block);
  }

  // 输出 32 字节
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (V[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (V[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (V[i] >>> 8) & 0xff;
    out[i * 4 + 3] = V[i] & 0xff;
  }
  return out;
}

/* ============================== 自定义 Base64 ============================== */
/* 标准算法，仅查表不同
 * 编码：每 3 字节 → 4 个 6-bit 字符
 * 不追加 padding（s3/s4 均无 padding 字符）
 */

function customBase64Encode(data: Uint8Array, table: string): string {
  let out = '';
  const len = data.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = data[i];
    const b1 = i + 1 < len ? data[i + 1] : 0;
    const b2 = i + 2 < len ? data[i + 2] : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += table[(triple >> 18) & 0x3f];
    out += table[(triple >> 12) & 0x3f];
    if (i + 1 < len) {
      out += table[(triple >> 6) & 0x3f];
    }
    if (i + 2 < len) {
      out += table[triple & 0x3f];
    }
  }
  return out;
}

/* ============================== RC4 变体 ============================== */
/* bdms 魔改 RC4：
 *   1. S-box 反转初始化：S = [255, 254, ..., 1, 0]
 *   2. 非标准 KSA：j = (j * S[i] + j + key[i % len(key)]) % 256
 *   3. 标准 PRGA
 * 密钥：单字节 0xD3
 */

function rc4Variant(key: number[], data: Uint8Array): Uint8Array {
  const len = key.length;

  // 反转 S-box
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    S[i] = 255 - i;
  }

  // 修改版 KSA：j = (j * S[i] + j + key[i % len]) % 256
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j * S[i] + j + key[i % len]) % 256;
    const tmp = S[i];
    S[i] = S[j];
    S[j] = tmp;
  }

  // 标准 PRGA
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

/* ============================== 位掩码扩展 ============================== */
/* garble_3to4: 每 3 字节输入 + 1 随机字节 → 4 字节输出
 *   out[0] = (rnd & A) | (data[0] & B)
 *   out[1] = (rnd & C) | (data[1] & D)
 *   out[2] = (rnd & E) | (data[2] & F)
 *   out[3] = (data[0] & A) | (data[1] & C) | (data[2] & E)
 * 掩码互补：A|B=255, C|D=255, E|F=255
 */
function garble3to4(data: Uint8Array): Uint8Array {
  const outLen = Math.floor(data.length / 3) * 4;
  const out = new Uint8Array(outLen);
  for (let i = 0, j = 0; i < data.length - 2; i += 3, j += 4) {
    const rnd = Math.floor(Math.random() * 256);
    out[j] = (rnd & MASK_A) | (data[i] & MASK_B);
    out[j + 1] = (rnd & MASK_C) | (data[i + 1] & MASK_D);
    out[j + 2] = (rnd & MASK_E) | (data[i + 2] & MASK_F);
    out[j + 3] = (data[i] & MASK_A) | (data[i + 1] & MASK_C) | (data[i + 2] & MASK_E);
  }
  return out;
}

/* garble_2to4: 2 字节输入 + 1 随机字节 → 4 字节输出
 * 掩码：0xAA / 0x55（互补）
 */
function garble2to4(d0: number, d1: number): Uint8Array {
  const rnd = Math.floor(Math.random() * 256);
  const out = new Uint8Array(4);
  out[0] = (rnd & MASK_AA) | (d0 & MASK_55);
  out[1] = (rnd & MASK_55) | (d0 & MASK_AA);
  out[2] = (rnd & MASK_AA) | (d1 & MASK_55);
  out[3] = (rnd & MASK_55) | (d1 & MASK_AA);
  return out;
}

/* ============================== Payload 组装 ============================== */

export interface ABogusInput {
  /** 请求 URL（不含 query） */
  url: string;
  /** 查询参数 */
  params: Record<string, unknown>;
  /** HTTP 方法 */
  method: 'GET' | 'POST';
  /** User-Agent */
  userAgent: string;
  /** 请求 body（POST 时，可为 string 或 object） */
  body?: unknown;
}

/**
 * 生成 a_bogus 签名
 *
 * 完整流程：
 *   1. SM3 二次哈希（盐 "dhzx"）→ url_hash / body_hash
 *   2. UA 经 s3 Base64 编码后 SM3 → ua_hash
 *   3. 组装 payload（固定域 + 可变域 + 校验和）
 *   4. garble_3to4 扩展
 *   5. RC4 变体加密（key=0xD3）
 *   6. s4 Base64 编码 → 192 字符
 */
export function generateABogus(input: ABogusInput): string {
  /* -------- 1. 参数序列化（URLSearchParams.toString 格式，空格为 +） --------
   * 参考文章 §2.2 明确指出：URL 参数必须是 URLSearchParams.toString() 的格式
   * 即仅查询串（如 "device_platform=webapp&aid=6383&..."），不包含 path 和 "?"
   */
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(input.params)) {
    usp.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const urlParams = usp.toString();

  /* -------- 2. body 序列化 -------- */
  const bodyStr =
    input.method === 'POST' && input.body != null
      ? typeof input.body === 'string'
        ? input.body
        : JSON.stringify(input.body)
      : '';

  /* -------- 3. SM3 二次哈希 --------
   * 参考文章 §2.1: url_hash = SM3(SM3(url_params + "dhzx"))
   * GET 时 body 仍计算（空字符串 + "dhzx"）
   */
  const urlHash1 = sm3(new TextEncoder().encode(urlParams + SALT));
  const urlHash = sm3(urlHash1);

  const bodyHash1 = sm3(new TextEncoder().encode(bodyStr + SALT));
  const bodyHash = sm3(bodyHash1);

  /* -------- 4. UA 哈希：s3 Base64 编码 → SM3 -------- */
  const uaBytes = new TextEncoder().encode(input.userAgent);
  const uaB64 = customBase64Encode(uaBytes, S3_TABLE);
  const uaHash = sm3(new TextEncoder().encode(uaB64));

  /* -------- 5. 时间戳与随机因子 -------- */
  const now = Date.now();
  // 时间戳拆 6 字节（低→高）
  const tsBytes = [
    now & 0xff,
    (now >>> 8) & 0xff,
    (now >>> 16) & 0xff,
    (now >>> 24) & 0xff,
    Number((BigInt(now) >> 32n) & 0xffn),
    Number((BigInt(now) >> 40n) & 0xffn),
  ];

  // 随机因子 4 字节
  const rand = Math.random();
  const randBytes = [
    Math.floor(rand * 256) & 0xff,
    Math.floor(rand * 65536) & 0xff,
    Math.floor(rand * 16777216) & 0xff,
    Math.floor(rand * 4294967296) & 0xff,
  ];

  /* -------- 6. 可变域：设备信息 + 时间编码 --------
   * 设备信息字段顺序（Z-table 11 字段实际使用 9 字段，缺失字段由 bdms 跳过）：
   *   innerWidth | innerHeight | outerWidth | outerHeight |
   *   availWidth | availHeight | screen.width | screen.height | platform
   *
   * 关键：outerWidth/outerHeight 必须与登录浏览器实际窗口外尺寸一致
   *       （window.outerWidth=1416, window.outerHeight=988，由 Playwright
   *        viewport={1400,900} + 浏览器窗口边框 16x88 推算得到）
   *       否则 a_bogus 长度会从 188 缩到 144
   */
  const screenW = 1400, screenH = 900;
  const outerW = 1416, outerH = 988;
  const platform = 'Win32';
  const deviceInfo = `${screenW}|${screenH}|${outerW}|${outerH}|${screenW}|${screenH}|${screenW}|${screenH}|${platform}`;
  const deviceBytes = new TextEncoder().encode(deviceInfo);

  // 时间编码：str((timestamp + 3) & 255) + ","
  const timeEnc = String((Math.floor(now / 1000) + 3) & 0xff) + ',';
  const timeBytes = new TextEncoder().encode(timeEnc);

  /* -------- 7. debugFlag (蜜罐检测) -------- */
  // bdms 通过拼错属性检测自动化环境，这里模拟正常浏览器环境（debugFlag=0）
  const debugFlag = 0;

  /* -------- 8. timeDiff: 距固定时间点的 14 天周期数 -------- */
  const epochBase = new Date('2020-01-01').getTime();
  const timeDiff = Math.floor((now - epochBase) / (14 * 24 * 60 * 60 * 1000)) & 0xff;

  /* -------- 9. browserRand: 浏览器类型随机值 (Chrome=0~39) -------- */
  const browserRand = Math.floor(Math.random() * 40);

  /* -------- 10. 组装 payload -------- */
  // 固定域
  const fixed = [
    ...tsBytes,        // 6 bytes: timestamp
    ...randBytes,      // 4 bytes: random factor
    urlHash[9], urlHash[18], urlHash[3],   // 3 bytes: URL hash
    bodyHash[10], bodyHash[19], bodyHash[4], // 3 bytes: body hash
    uaHash[11], uaHash[21], uaHash[5],     // 3 bytes: UA hash
    debugFlag,         // 1 byte
    timeDiff,          // 1 byte
    browserRand,       // 1 byte
    deviceBytes.length, // 1 byte: sLen
    timeBytes.length,  // 1 byte: tLen
    MAGIC,             // 1 byte: magic=41
  ]; // 共 6+4+3+3+3+1+1+1+1+1+1 = 25 bytes

  // 可变域
  const variable = [...deviceBytes, ...timeBytes];

  // 完整 payload（不含校验和）
  const payloadNoChecksum = [...fixed, ...variable];

  // XOR 校验和
  let checksum = 0;
  for (const b of payloadNoChecksum) checksum ^= b;

  const payload = new Uint8Array([...payloadNoChecksum, checksum]);

  // 确保 payload 长度为 3 的倍数（garble_3to4 要求）
  const remainder = payload.length % 3;
  let paddedPayload = payload;
  if (remainder !== 0) {
    const pad = 3 - remainder;
    paddedPayload = new Uint8Array(payload.length + pad);
    paddedPayload.set(payload);
  }

  /* -------- 11. 位掩码扩展 garble_3to4 -------- */
  const garbledPayload = garble3to4(paddedPayload);

  /* -------- 12. 版本号混淆 garble_2to4 -------- */
  // version_garbled = garble_2to4([1, 0]) + garble_2to4([1, 0])
  const v1 = garble2to4(1, 0);
  const v2 = garble2to4(1, 0);
  const versionGarbled = new Uint8Array(v1.length + v2.length);
  versionGarbled.set(v1, 0);
  versionGarbled.set(v2, v1.length);

  /* -------- 13. 前缀混淆 -------- */
  // prefix = garble_2to4([3, 82])
  const prefix = garble2to4(3, 82);

  /* -------- 14. RC4 变体加密 -------- */
  // rc4_input = version_garbled + garbled_payload
  const rc4Input = new Uint8Array(versionGarbled.length + garbledPayload.length);
  rc4Input.set(versionGarbled, 0);
  rc4Input.set(garbledPayload, versionGarbled.length);

  const rc4Output = rc4Variant([RC4_KEY], rc4Input);

  /* -------- 15. 最终 Base64 编码 -------- */
  // a_bogus = base64_s4(prefix + rc4_output)
  const finalData = new Uint8Array(prefix.length + rc4Output.length);
  finalData.set(prefix, 0);
  finalData.set(rc4Output, prefix.length);

  return customBase64Encode(finalData, S4_TABLE);
}
