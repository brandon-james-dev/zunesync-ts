/**
 * Cross-runtime binary writer that builds a byte buffer incrementally.
 *
 * Uses a resizable internal buffer. All multi-byte writes default to
 * **little-endian** to match the Zune on-disk and MTP wire formats.
 */
export class ZuneBinaryWriter {
  private _buffer: ArrayBuffer;
  private view: DataView;
  private _offset: number;
  private _littleEndian: boolean;

  constructor(initialCapacity = 4096, littleEndian = true) {
    this._buffer = new ArrayBuffer(initialCapacity);
    this.view = new DataView(this._buffer);
    this._offset = 0;
    this._littleEndian = littleEndian;
  }

  /** Current write position. */
  get offset(): number {
    return this._offset;
  }

  /** Set the write position to an absolute offset. */
  seek(position: number): void {
    this._offset = position;
  }

  /** Advance the write position by `n` bytes (writes zeros). */
  skip(n: number): void {
    this.ensureCapacity(this._offset + n);
    this._offset += n;
  }

  /**
   * Return the written portion of the buffer as a new ArrayBuffer,
   * trimmed to the current offset.
   */
  finalize(): ArrayBuffer {
    return this._buffer.slice(0, this._offset);
  }

  /** Return the written portion as a Uint8Array view. */
  toUint8Array(): Uint8Array {
    return new Uint8Array(this._buffer, 0, this._offset);
  }

  /** Write an unsigned 8-bit integer and advance by 1. */
  writeUint8(value: number): void {
    this.ensureCapacity(this._offset + 1);
    this.view.setUint8(this._offset, value & 0xff);
    this._offset += 1;
  }

  /** Write a signed 8-bit integer and advance by 1. */
  writeInt8(value: number): void {
    this.ensureCapacity(this._offset + 1);
    this.view.setInt8(this._offset, value);
    this._offset += 1;
  }

  /** Write an unsigned 16-bit integer and advance by 2. */
  writeUint16(value: number): void {
    this.ensureCapacity(this._offset + 2);
    this.view.setUint16(this._offset, value & 0xffff, this._littleEndian);
    this._offset += 2;
  }

  /** Write a signed 16-bit integer and advance by 2. */
  writeInt16(value: number): void {
    this.ensureCapacity(this._offset + 2);
    this.view.setInt16(this._offset, value, this._littleEndian);
    this._offset += 2;
  }

  /** Write an unsigned 32-bit integer and advance by 4. */
  writeUint32(value: number): void {
    this.ensureCapacity(this._offset + 4);
    this.view.setUint32(this._offset, value >>> 0, this._littleEndian);
    this._offset += 4;
  }

  /** Write a signed 32-bit integer and advance by 4. */
  writeInt32(value: number): void {
    this.ensureCapacity(this._offset + 4);
    this.view.setInt32(this._offset, value, this._littleEndian);
    this._offset += 4;
  }

  /** Write an unsigned 64-bit integer and advance by 8. */
  writeUint64(value: bigint): void {
    this.ensureCapacity(this._offset + 8);
    this.view.setBigUint64(this._offset, BigInt.asUintN(64, value), this._littleEndian);
    this._offset += 8;
  }

  /** Write a signed 64-bit integer and advance by 8. */
  writeInt64(value: bigint): void {
    this.ensureCapacity(this._offset + 8);
    this.view.setBigInt64(this._offset, BigInt.asIntN(64, value), this._littleEndian);
    this._offset += 8;
  }

  /** Write raw bytes and advance by their length. */
  writeBytes(bytes: Uint8Array): void {
    this.ensureCapacity(this._offset + bytes.length);
    new Uint8Array(this._buffer).set(bytes, this._offset);
    this._offset += bytes.length;
  }

  /** Write an ASCII string, one code unit per byte. */
  writeAscii(text: string): void {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    this.writeBytes(bytes);
  }

  /** Write a UTF-16LE string. */
  writeUtf16le(text: string): void {
    const bytes = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      bytes[i * 2] = code & 0xff;
      bytes[i * 2 + 1] = (code >> 8) & 0xff;
    }
    this.writeBytes(bytes);
  }

  /** Write a UTF-8 string followed by a NUL terminator. */
  writeNullTerminatedUtf8(text: string): void {
    this.writeBytes(utf8ToBytes(text));
    this.writeUint8(0);
  }

  /** Pad the buffer with zeros until the offset is a multiple of `alignment`. */
  align(alignment: number): void {
    const remainder = this._offset % alignment;
    if (remainder !== 0) this.skip(alignment - remainder);
  }

  private ensureCapacity(required: number): void {
    if (required <= this._buffer.byteLength) return;
    let capacity = this._buffer.byteLength;
    while (capacity < required) capacity *= 2;
    const next = new ArrayBuffer(capacity);
    new Uint8Array(next).set(new Uint8Array(this._buffer, 0, this._offset));
    this._buffer = next;
    this.view = new DataView(next);
  }
}

/** Encode a string as UTF-8 without depending on a runtime-specific `Buffer`. */
export function utf8ToBytes(text: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text);
  }
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return new Uint8Array(out);
}
