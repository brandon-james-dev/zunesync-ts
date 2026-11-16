/**
 * Cryptographically secure random bytes from the platform's WebCrypto
 * implementation.
 *
 * `globalThis.crypto.getRandomValues` exists in every browser, in Node 20+ and
 * in Tauri's webview, so no `node:crypto` import is needed. Node 18 is excluded
 * because `crypto` only became a default global in Node 19; on 18 it is present
 * solely behind `--experimental-global-webcrypto`.
 */

/** Fill a new array with `length` cryptographically secure random bytes. */
export function getRandomBytes(length: number): Uint8Array {
  const source = (globalThis as { crypto?: Crypto }).crypto;
  if (!source?.getRandomValues) {
    throw new Error(
      'No secure random source available: globalThis.crypto.getRandomValues is missing'
    );
  }

  const out = new Uint8Array(length);
  source.getRandomValues(out);
  return out;
}
