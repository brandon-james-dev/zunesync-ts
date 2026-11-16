import { FILETIME_EPOCH_DIFFERENCE_MS, FILETIME_TICKS_PER_MS } from '../constants/index.js';
import { utf16leFromBytes, utf8FromBytes } from '../binary/reader.js';

/**
 * Convert a Windows FILETIME (100 ns ticks since 1601-01-01) to a Date.
 * Returns `null` for zero or for values that predate the Unix epoch.
 */
export function filetimeToDate(filetime: bigint): Date | null {
  if (filetime <= 0n) return null;
  const ms = Number(filetime / FILETIME_TICKS_PER_MS) - FILETIME_EPOCH_DIFFERENCE_MS;
  return ms > 0 ? new Date(ms) : null;
}

/** Convert a Windows FILETIME to an ISO-8601 string, or `null`. */
export function filetimeToISOString(filetime: bigint): string | null {
  return filetimeToDate(filetime)?.toISOString() ?? null;
}

/** Convert a Date to a Windows FILETIME (100 ns ticks since 1601-01-01). */
export function dateToFiletime(date: Date): bigint {
  return BigInt(date.getTime() + FILETIME_EPOCH_DIFFERENCE_MS) * FILETIME_TICKS_PER_MS;
}

/**
 * Read a NUL-terminated UTF-8 string, stripping the leading encoding
 * artifacts some ZMDB records carry: replacement characters, a BOM,
 * geometric shapes (U+25A0–U+25FF) and misc symbols (U+2600–U+26FF).
 */
export function readNullTerminatedUtf8(bytes: Uint8Array, offset: number, maxLen = 1024): string {
  if (offset >= bytes.length) return '';
  const end = Math.min(offset + maxLen, bytes.length);
  let i = offset;
  while (i < end && bytes[i] !== 0) i++;
  if (i === offset) return '';
  return utf8FromBytes(bytes.subarray(offset, i)).replace(/^[\ufffd\ufeff\u25a0-\u25ff\u2600-\u26ff]+\s*/, '');
}

/** Read a NUL-terminated UTF-16LE string. */
export function readNullTerminatedUtf16le(bytes: Uint8Array, offset: number, maxLen = 2048): string {
  if (offset >= bytes.length) return '';
  const end = Math.min(offset + maxLen, bytes.length);
  let i = offset;
  while (i + 1 < end) {
    if (bytes[i] === 0 && bytes[i + 1] === 0) break;
    i += 2;
  }
  if (i === offset) return '';
  return utf16leFromBytes(bytes.subarray(offset, i));
}

/** Decode a UTF-16LE range, stopping at the first NUL code unit. */
export function utf16leToString(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let result = '';
  for (let i = start; i + 1 < end; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    if (code === 0) break;
    result += String.fromCharCode(code);
  }
  return result;
}

/**
 * Decode the UTF-16LE payload of a backwards-varint field. Some fields
 * carry a leading pad byte (odd length); all are NUL-terminated.
 */
export function utf16Field(bytes: Uint8Array): string {
  const data = bytes.length % 2 === 1 && bytes[0] === 0 ? bytes.subarray(1) : bytes;
  return utf16leFromBytes(data).replace(/\0[\s\S]*$/, '');
}

/** Strip characters the Zune file system rejects and cap the name at 120 chars. */
export function zuneSafeName(name: string): string {
  const safe = String(name ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120);
  return safe || 'Untitled';
}

/** Format a date as an MTP `DateAuthored` value: `YYYYMMDDTHHMMSS.0`. */
export function formatDateAuthored(value: Date | string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.0`
  );
}

/** Collapse HTML to plain text for podcast descriptions. */
export function stripHtml(text: string | null | undefined, maxLength = 1000): string {
  return String(text ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}
