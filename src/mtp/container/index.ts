import { MTP_CONTAINER_HEADER_SIZE } from '../../common/constants/index.js';
import { ZuneError } from '../../common/errors/index.js';
import { ZuneBinaryReader } from '../../common/binary/reader.js';
import { ZuneBinaryWriter } from '../../common/binary/writer.js';
import { ContainerType, DataType } from '../constants/index.js';
import type { MtpContainer, MtpPropValue } from '../types.js';

/** Build a command or response container with a 32-bit parameter list. */
export function buildContainer(
  type: number,
  code: number,
  transactionId: number,
  params: number[] = [],
): Uint8Array {
  const writer = new ZuneBinaryWriter(MTP_CONTAINER_HEADER_SIZE + params.length * 4);
  writer.writeUint32(MTP_CONTAINER_HEADER_SIZE + params.length * 4);
  writer.writeUint16(type);
  writer.writeUint16(code);
  writer.writeUint32(transactionId);
  for (const param of params) writer.writeUint32(param);
  return writer.toUint8Array();
}

/** Build a data container carrying an opaque payload. */
export function buildDataContainer(code: number, transactionId: number, payload: Uint8Array): Uint8Array {
  const writer = new ZuneBinaryWriter(MTP_CONTAINER_HEADER_SIZE + payload.length);
  writer.writeUint32(MTP_CONTAINER_HEADER_SIZE + payload.length);
  writer.writeUint16(ContainerType.DATA);
  writer.writeUint16(code);
  writer.writeUint32(transactionId);
  writer.writeBytes(payload);
  return writer.toUint8Array();
}

/**
 * Decode one container from a buffer.
 *
 * Command and response containers carry 32-bit parameters after the
 * header; data containers carry an opaque payload instead.
 */
export function parseContainer(buffer: Uint8Array): MtpContainer {
  if (buffer.length < MTP_CONTAINER_HEADER_SIZE) {
    throw new ZuneError('MTP_CONTAINER', `Container shorter than ${MTP_CONTAINER_HEADER_SIZE} bytes`);
  }

  const reader = new ZuneBinaryReader(buffer);
  const length = reader.readUint32();
  const type = reader.readUint16();
  const code = reader.readUint16();
  const transactionId = reader.readUint32();

  if (length < MTP_CONTAINER_HEADER_SIZE || length > buffer.length) {
    throw new ZuneError('MTP_CONTAINER', `Invalid container length ${length} for ${buffer.length} bytes`);
  }

  if (type === ContainerType.DATA) {
    return {
      length,
      type,
      code,
      transactionId,
      params: [],
      payload: buffer.slice(MTP_CONTAINER_HEADER_SIZE, length),
    };
  }

  const paramCount = Math.floor((length - MTP_CONTAINER_HEADER_SIZE) / 4);
  const params: number[] = [];
  for (let i = 0; i < paramCount; i++) params.push(reader.readUint32());

  return {
    length,
    type,
    code,
    transactionId,
    params,
    payload: buffer.slice(MTP_CONTAINER_HEADER_SIZE + paramCount * 4, length),
  };
}

/** Encode an MTP string: one length byte (including the NUL), UTF-16LE, NUL. */
export function encodeMtpString(text: string): Uint8Array {
  const capped = text.length > 254 ? text.slice(0, 254) : text;
  const writer = new ZuneBinaryWriter(capped.length * 2 + 2);
  writer.writeUint8(capped.length + 1);
  writer.writeUtf16le(capped);
  writer.writeUint16(0);
  return writer.toUint8Array();
}

/** Decode an MTP string at `offset`, returning the text and the next offset. */
export function decodeMtpString(
  bytes: Uint8Array,
  offset = 0,
): { value: string; offset: number } {
  if (offset >= bytes.length) return { value: '', offset };
  const charCount = bytes[offset];
  const start = offset + 1;
  const end = Math.min(start + charCount * 2, bytes.length);
  let value = '';
  for (let i = start; i + 1 < end; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    if (code === 0) break;
    value += String.fromCharCode(code);
  }
  return { value, offset: start + charCount * 2 };
}

/**
 * Encode a property list (`SendObjectPropList` payload).
 *
 * Each element is an 8-byte head followed by its value:
 *   `uint32` object handle, `uint16` property code, `uint16` data type.
 *
 * The property code is 16 bits, not 32: writing it as a `uint32` made every
 * head 10 bytes and shifted every following field by two, so the device
 * rejected the list and nothing was written.
 */
export function encodePropList(props: MtpPropValue[], handle = 0): Uint8Array {
  const writer = new ZuneBinaryWriter(64);
  writer.writeUint32(props.length);

  for (const prop of props) {
    writer.writeUint32(handle >>> 0);
    writer.writeUint16(prop.property);
    writer.writeUint16(prop.type);
    writePropValue(writer, prop);
  }

  return writer.toUint8Array();
}

function writePropValue(writer: ZuneBinaryWriter, prop: MtpPropValue): void {
  if (prop.value instanceof Uint8Array) {
    writer.writeUint32(prop.value.length);
    writer.writeBytes(prop.value);
    return;
  }

  switch (prop.type) {
    case DataType.INT8:
    case DataType.UINT8:
      writer.writeUint8(Number(prop.value));
      break;
    case DataType.INT16:
    case DataType.UINT16:
      writer.writeUint16(Number(prop.value));
      break;
    case DataType.INT32:
    case DataType.UINT32:
      writer.writeUint32(Number(prop.value));
      break;
    case DataType.INT64:
    case DataType.UINT64:
      writer.writeUint64(BigInt(prop.value as bigint | number));
      break;
    case DataType.STR:
      writer.writeBytes(encodeMtpString(String(prop.value)));
      break;
    case DataType.AUINT16: {
      // The firmware expects a NUL-terminated UTF-16LE array with the count in
      // code units; without the terminator it appends stale buffer bytes.
      const text = typeof prop.value === "string" ? `${prop.value}\0` : null;
      const values = text === null ? (prop.value as unknown as number[]) : null;

      if (text !== null) {
        writer.writeUint32(text.length);
        writer.writeUtf16le(text);
      } else {
        writer.writeUint32(values!.length);
        for (const value of values!) writer.writeUint16(value);
      }
      break;
    }
    case DataType.AUINT32: {
      const values = prop.value as unknown as number[];
      writer.writeUint32(values.length);
      for (const value of values) writer.writeUint32(value);
      break;
    }
    default:
      throw new ZuneError('UNSUPPORTED_FORMAT', `Unsupported property data type 0x${prop.type.toString(16)}`);
  }
}

/** Decode a `uint32` array payload (`GetObjectHandles`, `GetStorageIDs`). */
export function decodeUint32Array(payload: Uint8Array): number[] {
  if (payload.length < 4) return [];
  const reader = new ZuneBinaryReader(payload);
  const count = reader.readUint32();
  const values: number[] = [];
  for (let i = 0; i < count && reader.remaining >= 4; i++) values.push(reader.readUint32());
  return values;
}
