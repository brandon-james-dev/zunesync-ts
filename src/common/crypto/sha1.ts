/**
 * SHA-1 (RFC 3174) over `Uint8Array`.
 *
 * The MTPZ handshake hashes the certificate message and derives the OAEP
 * mask with SHA-1. Implemented here so no `node:crypto` import reaches the
 * browser bundle.
 */

const K0 = 0x5a827999;
const K1 = 0x6ed9eba1;
const K2 = 0x8f1bbcdc;
const K3 = 0xca62c1d6;

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

/**
 * Compute the SHA-1 digest of `data`.
 *
 * @returns The 20-byte digest.
 */
export function sha1(data: Uint8Array): Uint8Array {
  const bitLength = data.length * 8;
  const padded = new Uint8Array((data.length + 8 + 64) & ~63);
  padded.set(data);
  padded[data.length] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLength >>> 0);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000) >>> 0);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Uint32Array(80);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;

      if (i < 20) {
        f = (b & c) | (~b & d);
        k = K0;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = K1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = K2;
      } else {
        f = b ^ c ^ d;
        k = K3;
      }

      const temp = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0);
  outView.setUint32(4, h1);
  outView.setUint32(8, h2);
  outView.setUint32(12, h3);
  outView.setUint32(16, h4);
  return out;
}
