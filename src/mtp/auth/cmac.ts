import { aesEcbEncrypt } from '../../common/crypto/aes.js';

/** Left-shift a 16-byte block by one bit, in big-endian order. */
export function leftShiftBlock(block: Uint8Array): Uint8Array {
  const shifted = new Uint8Array(block.length);
  for (let i = 0; i < block.length - 1; i++) {
    shifted[i] = ((block[i] << 1) | (block[i + 1] >> 7)) & 0xff;
  }
  shifted[block.length - 1] = (block[block.length - 1] << 1) & 0xff;
  return shifted;
}

/**
 * AES-CMAC (RFC 4493) over arbitrary-length input.
 *
 * Used by the MTPZ handshake to prove the session key was decrypted
 * correctly, and to derive the four trusted-operation hashes.
 */
export function aesCmac(key: Uint8Array, data: Uint8Array): Uint8Array {
  const zeroes = new Uint8Array(16);
  const l = aesEcbEncrypt(key, zeroes);

  const k1 = leftShiftBlock(l);
  if (l[0] & 0x80) k1[15] ^= 0x87;

  const k2 = leftShiftBlock(k1);
  if (k1[0] & 0x80) k2[15] ^= 0x87;

  const blockCount = Math.max(1, Math.ceil(data.length / 16));
  const lastComplete = data.length > 0 && data.length % 16 === 0;

  let x: Uint8Array = new Uint8Array(16);
  for (let i = 0; i < blockCount - 1; i++) {
    const block = data.subarray(i * 16, i * 16 + 16);
    for (let j = 0; j < 16; j++) x[j] ^= block[j];
    x = aesEcbEncrypt(key, x);
  }

  const last = new Uint8Array(16);
  const lastStart = (blockCount - 1) * 16;
  const lastBytes = data.subarray(lastStart, lastStart + 16);
  last.set(lastBytes);
  if (!lastComplete) last[lastBytes.length] = 0x80;

  const subkey = lastComplete ? k1 : k2;
  for (let j = 0; j < 16; j++) last[j] ^= subkey[j];
  for (let j = 0; j < 16; j++) x[j] ^= last[j];

  return aesEcbEncrypt(key, x);
}
