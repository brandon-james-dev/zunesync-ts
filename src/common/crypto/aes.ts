/**
 * Pure-TypeScript AES-128 (FIPS-197).
 *
 * The MTPZ handshake needs AES-128-ECB encryption (for AES-CMAC) and
 * AES-128-CBC decryption (for the device challenge). Both run here on
 * `Uint8Array` alone so the library works in the browser, in Node and in
 * Tauri without `node:crypto` or an async WebCrypto round-trip.
 *
 * Verified against the FIPS-197 appendix C.1 vector and the NIST SP 800-38A
 * ECB/CBC vectors.
 */

const SBOX = new Uint8Array([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]);

const INV_SBOX = new Uint8Array(256);
for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;

const RCON = new Uint8Array([0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36]);

/** Multiply by x in GF(2^8) modulo the AES polynomial. */
function xtime(value: number): number {
  return ((value << 1) ^ ((value & 0x80) !== 0 ? 0x1b : 0)) & 0xff;
}

/** Multiply two bytes in GF(2^8). */
function gmul(a: number, b: number): number {
  let product = 0;
  let x = a;
  let y = b;
  while (y > 0) {
    if (y & 1) product ^= x;
    x = xtime(x);
    y >>= 1;
  }
  return product & 0xff;
}

/** Expand a 16-byte key into eleven 16-byte round keys (176 bytes). */
function expandKey(key: Uint8Array): Uint8Array {
  const schedule = new Uint8Array(176);
  schedule.set(key.subarray(0, 16));

  let generated = 16;
  let rconIndex = 0;
  const word = new Uint8Array(4);

  while (generated < 176) {
    word.set(schedule.subarray(generated - 4, generated));

    if (generated % 16 === 0) {
      const first = word[0];
      word[0] = word[1];
      word[1] = word[2];
      word[2] = word[3];
      word[3] = first;
      for (let i = 0; i < 4; i++) word[i] = SBOX[word[i]];
      word[0] ^= RCON[rconIndex++];
    }

    for (let i = 0; i < 4; i++) {
      schedule[generated] = schedule[generated - 16] ^ word[i];
      generated++;
    }
  }

  return schedule;
}

function addRoundKey(state: Uint8Array, schedule: Uint8Array, offset: number): void {
  for (let i = 0; i < 16; i++) state[i] ^= schedule[offset + i];
}

function subBytes(state: Uint8Array): void {
  for (let i = 0; i < 16; i++) state[i] = SBOX[state[i]];
}

function invSubBytes(state: Uint8Array): void {
  for (let i = 0; i < 16; i++) state[i] = INV_SBOX[state[i]];
}

/** Row `r` of the column-major state sits at indices `r`, `r + 4`, `r + 8`, `r + 12`. */
function shiftRows(state: Uint8Array): void {
  let t = state[1];
  state[1] = state[5];
  state[5] = state[9];
  state[9] = state[13];
  state[13] = t;

  t = state[2];
  state[2] = state[10];
  state[10] = t;
  t = state[6];
  state[6] = state[14];
  state[14] = t;

  t = state[15];
  state[15] = state[11];
  state[11] = state[7];
  state[7] = state[3];
  state[3] = t;
}

function invShiftRows(state: Uint8Array): void {
  let t = state[13];
  state[13] = state[9];
  state[9] = state[5];
  state[5] = state[1];
  state[1] = t;

  t = state[2];
  state[2] = state[10];
  state[10] = t;
  t = state[6];
  state[6] = state[14];
  state[14] = t;

  t = state[3];
  state[3] = state[7];
  state[7] = state[11];
  state[11] = state[15];
  state[15] = t;
}

function mixColumns(state: Uint8Array): void {
  for (let column = 0; column < 4; column++) {
    const i = column * 4;
    const a0 = state[i];
    const a1 = state[i + 1];
    const a2 = state[i + 2];
    const a3 = state[i + 3];

    state[i] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3;
    state[i + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3;
    state[i + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3);
    state[i + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2);
  }
}

function invMixColumns(state: Uint8Array): void {
  for (let column = 0; column < 4; column++) {
    const i = column * 4;
    const a0 = state[i];
    const a1 = state[i + 1];
    const a2 = state[i + 2];
    const a3 = state[i + 3];

    state[i] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
    state[i + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
    state[i + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
    state[i + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
  }
}

/** Encrypt one 16-byte block with a pre-expanded key schedule. */
function encryptBlockWithSchedule(schedule: Uint8Array, block: Uint8Array): Uint8Array {
  const state = new Uint8Array(16);
  state.set(block.subarray(0, 16));

  addRoundKey(state, schedule, 0);
  for (let round = 1; round < 10; round++) {
    subBytes(state);
    shiftRows(state);
    mixColumns(state);
    addRoundKey(state, schedule, round * 16);
  }
  subBytes(state);
  shiftRows(state);
  addRoundKey(state, schedule, 160);

  return state;
}

/** Decrypt one 16-byte block with a pre-expanded key schedule. */
function decryptBlockWithSchedule(schedule: Uint8Array, block: Uint8Array): Uint8Array {
  const state = new Uint8Array(16);
  state.set(block.subarray(0, 16));

  addRoundKey(state, schedule, 160);
  for (let round = 9; round >= 1; round--) {
    invShiftRows(state);
    invSubBytes(state);
    addRoundKey(state, schedule, round * 16);
    invMixColumns(state);
  }
  invShiftRows(state);
  invSubBytes(state);
  addRoundKey(state, schedule, 0);

  return state;
}

/** Encrypt one 16-byte block with a 16-byte key. */
export function aesEncryptBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  return encryptBlockWithSchedule(expandKey(key), block);
}

/** Decrypt one 16-byte block with a 16-byte key. */
export function aesDecryptBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  return decryptBlockWithSchedule(expandKey(key), block);
}

/**
 * AES-128-ECB encryption without padding.
 *
 * `data` must be a multiple of 16 bytes; AES-CMAC pads its own final block.
 */
export function aesEcbEncrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length % 16 !== 0) {
    throw new Error(`AES-ECB input must be a multiple of 16 bytes (got ${data.length})`);
  }

  const schedule = expandKey(key);
  const out = new Uint8Array(data.length);
  for (let offset = 0; offset < data.length; offset += 16) {
    out.set(encryptBlockWithSchedule(schedule, data.subarray(offset, offset + 16)), offset);
  }
  return out;
}

/**
 * AES-128-CBC decryption without padding.
 *
 * `data` must be a multiple of 16 bytes. The MTPZ payload is already
 * block-aligned, so no padding is stripped.
 */
export function aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length % 16 !== 0) {
    throw new Error(`AES-CBC input must be a multiple of 16 bytes (got ${data.length})`);
  }

  const schedule = expandKey(key);
  const out = new Uint8Array(data.length);
  let previous = iv.subarray(0, 16);

  for (let offset = 0; offset < data.length; offset += 16) {
    const cipherBlock = data.subarray(offset, offset + 16);
    const plainBlock = decryptBlockWithSchedule(schedule, cipherBlock);
    for (let i = 0; i < 16; i++) out[offset + i] = plainBlock[i] ^ previous[i];
    previous = cipherBlock;
  }

  return out;
}

/** AES-128-CBC encryption without padding, used by tests and fixtures. */
export function aesCbcEncrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length % 16 !== 0) {
    throw new Error(`AES-CBC input must be a multiple of 16 bytes (got ${data.length})`);
  }

  const schedule = expandKey(key);
  const out = new Uint8Array(data.length);
  let previous = iv.subarray(0, 16);

  for (let offset = 0; offset < data.length; offset += 16) {
    const block = new Uint8Array(16);
    for (let i = 0; i < 16; i++) block[i] = data[offset + i] ^ previous[i];
    const cipherBlock = encryptBlockWithSchedule(schedule, block);
    out.set(cipherBlock, offset);
    previous = cipherBlock;
  }

  return out;
}
