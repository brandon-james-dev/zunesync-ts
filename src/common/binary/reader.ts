/**
 * Cross-runtime binary reader that wraps a DataView over a byte buffer.
 * Works in browser, Node, and Tauri environments.
 *
 * All multi-byte reads default to **little-endian** to match the Zune
 * on-disk and MTP wire formats. Pass `bigEndian = true` for the
 * big-endian sections of the MTPZ handshake.
 */
export class ZuneBinaryReader {
  private view: DataView;
  private bytes: Uint8Array;
  private _offset: number;
  private _littleEndian: boolean;

  constructor(buffer: ArrayBuffer | Uint8Array, offset = 0, littleEndian = true) {
    this.bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this._offset = offset;
    this._littleEndian = littleEndian;
  }

  /** Current byte position in the buffer. */
  get offset(): number {
    return this._offset;
  }

  /** Total byte length of the underlying buffer. */
  get length(): number {
    return this.bytes.byteLength;
  }

  /** Number of bytes remaining from the current offset. */
  get remaining(): number {
    return this.bytes.byteLength - this._offset;
  }

  /** Advance the offset by `n` bytes without reading. */
  skip(n: number): void {
    this._offset += n;
  }

  /** Set the offset to an absolute position. */
  seek(position: number): void {
    this._offset = position;
  }

  /** Read an unsigned 8-bit integer and advance by 1. */
  readUint8(): number {
    const v = this.view.getUint8(this._offset);
    this._offset += 1;
    return v;
  }

  /** Read a signed 8-bit integer and advance by 1. */
  readInt8(): number {
    const v = this.view.getInt8(this._offset);
    this._offset += 1;
    return v;
  }

  /** Read an unsigned 16-bit integer and advance by 2. */
  readUint16(): number {
    const v = this.view.getUint16(this._offset, this._littleEndian);
    this._offset += 2;
    return v;
  }

  /** Read a signed 16-bit integer and advance by 2. */
  readInt16(): number {
    const v = this.view.getInt16(this._offset, this._littleEndian);
    this._offset += 2;
    return v;
  }

  /** Read an unsigned 32-bit integer and advance by 4. */
  readUint32(): number {
    const v = this.view.getUint32(this._offset, this._littleEndian);
    this._offset += 4;
    return v;
  }

  /** Read a signed 32-bit integer and advance by 4. */
  readInt32(): number {
    const v = this.view.getInt32(this._offset, this._littleEndian);
    this._offset += 4;
    return v;
  }

  /** Read an unsigned 64-bit integer as a bigint and advance by 8. */
  readUint64(): bigint {
    const v = this.view.getBigUint64(this._offset, this._littleEndian);
    this._offset += 8;
    return v;
  }

  /** Read a signed 64-bit integer as a bigint and advance by 8. */
  readInt64(): bigint {
    const v = this.view.getBigInt64(this._offset, this._littleEndian);
    this._offset += 8;
    return v;
  }

  /** Read `n` raw bytes and advance by `n`. */
  readBytes(n: number): Uint8Array {
    const out = this.bytes.slice(this._offset, this._offset + n);
    this._offset += n;
    return out;
  }

  /** Read `n` bytes as an ASCII string and advance by `n`. */
  readAscii(n: number): string {
    return asciiFromBytes(this.readBytes(n));
  }

  /** Read `n` bytes as a UTF-16LE string and advance by `n`. */
  readUtf16le(n: number): string {
    return utf16leFromBytes(this.readBytes(n));
  }

  /** Read a NUL-terminated UTF-8 string, capped at `maxLen` bytes. */
  readNullTerminatedUtf8(maxLen = 1024): string {
    const end = Math.min(this._offset + maxLen, this.bytes.byteLength);
    let i = this._offset;
    while (i < end && this.bytes[i] !== 0) i++;
    const out = utf8FromBytes(this.bytes.subarray(this._offset, i));
    this._offset = i;
    return out;
  }

  /** Read a NUL-terminated UTF-16LE string, capped at `maxLen` bytes. */
  readNullTerminatedUtf16le(maxLen = 2048): string {
    const end = Math.min(this._offset + maxLen, this.bytes.byteLength);
    let i = this._offset;
    while (i + 1 < end) {
      if (this.bytes[i] === 0 && this.bytes[i + 1] === 0) break;
      i += 2;
    }
    const out = utf16leFromBytes(this.bytes.subarray(this._offset, i));
    this._offset = i;
    return out;
  }

  /** Return a copy of the bytes between two absolute offsets. */
  slice(start: number, end: number): Uint8Array {
    return this.bytes.slice(start, end);
  }

  /** The underlying byte view, without copying. */
  get buffer(): Uint8Array {
    return this.bytes;
  }
}

/** Decode bytes as UTF-8 without depending on a runtime-specific `Buffer`. */
export function utf8FromBytes(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') {
    return new TextDecoder('utf-8').decode(bytes);
  }
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/** Decode bytes as UTF-16LE without depending on a runtime-specific `Buffer`. */
export function utf16leFromBytes(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
  }
  return out;
}

/** Decode bytes as ASCII, one code unit per byte. */
export function asciiFromBytes(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}
