import { sha1 } from '../../common/crypto/sha1.js';
import { MTPZ_MODULUS, MTPZ_PRIVATE_KEY, MTPZ_PUBLIC_EXPONENT } from './keys.js';
import { MTPZ_RSA_BLOCK_SIZE } from '../../common/constants/index.js';

/** Modular exponentiation for non-negative bigints. */
export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;

  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    e >>= 1n;
    b = (b * b) % modulus;
  }

  return result;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex ? BigInt(`0x${hex}`) : 0n;
}

function bigIntToBytes(value: bigint, length: number): Uint8Array {
  const hex = value.toString(16).padStart(length * 2, '0');
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** Raw (unpadded) RSA private-key operation with the MTPZ key pair. */
export function rsaRawPrivate(data: Uint8Array): Uint8Array {
  const message = bytesToBigInt(data);
  const result = modPow(message, BigInt(`0x${MTPZ_PRIVATE_KEY}`), BigInt(`0x${MTPZ_MODULUS}`));
  return bigIntToBytes(result, MTPZ_RSA_BLOCK_SIZE);
}

/** Raw (unpadded) RSA public-key operation, used to verify signatures. */
export function rsaRawPublic(data: Uint8Array): Uint8Array {
  const message = bytesToBigInt(data);
  const result = modPow(message, BigInt(`0x${MTPZ_PUBLIC_EXPONENT}`), BigInt(`0x${MTPZ_MODULUS}`));
  return bigIntToBytes(result, MTPZ_RSA_BLOCK_SIZE);
}

/** MGF1 mask generation with SHA-1 (PKCS#1 v2.1). */
export function mgf1Sha1(seed: Uint8Array, length: number): Uint8Array {
  const iterations = Math.ceil(length / 20);
  const chunks: Uint8Array[] = [];

  for (let counter = 0; counter < iterations; counter++) {
    const counterBytes = new Uint8Array(4);
    new DataView(counterBytes.buffer).setUint32(0, counter, false);
    const input = new Uint8Array(seed.length + 4);
    input.set(seed);
    input.set(counterBytes, seed.length);
    chunks.push(sha1(input));
  }

  const mask = new Uint8Array(iterations * 20);
  let offset = 0;
  for (const chunk of chunks) {
    mask.set(chunk, offset);
    offset += chunk.length;
  }
  return mask.subarray(0, length);
}

/** Compare two byte arrays for equality. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
