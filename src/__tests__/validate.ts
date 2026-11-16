import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';

import {
  ZuneBinaryReader,
  ZuneBinaryWriter,
  aesCbcDecrypt,
  aesCbcEncrypt,
  aesDecryptBlock,
  aesEcbEncrypt,
  aesEncryptBlock,
  dateToFiletime,
  filetimeToDate,
  formatDateAuthored,
  getRandomBytes,
  sha1,
  stripHtml,
  zuneSafeName,
} from '../common/index.js';
import { parseBackwardsVarints } from '../zmdb/varint/index.js';
import { parseDatabase, ZMDB } from '../zmdb/database/index.js';
import { Schema } from '../zmdb/constants/index.js';
import {
  buildContainer,
  buildDataContainer,
  decodeMtpString,
  encodeMtpString,
  encodePropList,
  parseContainer,
} from '../mtp/container/index.js';
import { ContainerType, DataType, ObjectProperty, OperationCode, ResponseCode } from '../mtp/constants/index.js';
import { MemoryTransport } from '../mtp/transport/MemoryTransport.js';
import { MtpProtocol } from '../mtp/protocol/MtpProtocol.js';
import { aesCmac } from '../mtp/auth/cmac.js';
import { mgf1Sha1, rsaRawPrivate, rsaRawPublic } from '../mtp/auth/rsa.js';
import { MtpzAuth } from '../mtp/auth/MtpzAuth.js';
import { MTPZ_CERTIFICATES } from '../mtp/auth/keys.js';
import { Zune, formatForFilename, stripExtension } from '../zune/index.js';
import { detectDevice, getZuneModelVariants, isZuneProductId, ZUNE_MODELS } from '../device/index.js';

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push(`${name}: ${(error as Error).message}`);
    console.log(`  FAIL ${name}`);
    console.log(`       ${(error as Error).message}`);
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(value: string): Uint8Array {
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(value.substr(i * 2, 2), 16);
  return out;
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function utf8(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

function utf16(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf16le'));
}

function backwardsField(fieldId: number, payload: Uint8Array): Uint8Array {
  const encodeVarint = (value: number): number[] => {
    const bytes = [value & 0x7f];
    let rest = value >> 7;
    while (rest > 0) {
      bytes[bytes.length - 1] |= 0x80;
      bytes.push(rest & 0x7f);
      rest >>= 7;
    }
    return bytes.reverse();
  };
  return concat([payload, new Uint8Array(encodeVarint(payload.length)), new Uint8Array(encodeVarint(fieldId))]);
}

function buildZmdb(): Uint8Array {
  const buffer = new Uint8Array(16384);
  const view = new DataView(buffer.buffer);

  buffer.set(ascii('ZMDB'), 0);
  buffer.set(ascii('ZMed'), 0x20);
  view.setUint16(0x24, 5, true);
  buffer.set(ascii('ZArr'), 0x30);

  const descriptor = (index: number, entrySize: number, entryCount: number, dataOffset: number): void => {
    const base = 0x30 + index * 20;
    view.setUint16(base + 6, entrySize, true);
    view.setUint32(base + 8, entryCount, true);
    view.setUint32(base + 16, dataOffset, true);
  };

  const artistId = 0x08000001;
  const albumId = 0x06000001;
  const genreId = 0x09000001;
  const filenameId = 0x05000001;
  const trackId = 0x01000001;

  const indexOffset = 0x800;
  const indexIds = [artistId, albumId, genreId, filenameId, trackId];
  const musicEntriesOffset = indexOffset + indexIds.length * 8;
  let cursor = musicEntriesOffset + 4;

  const writeRecord = (record: Uint8Array): number => {
    const recordOffset = cursor + 4;
    view.setUint32(cursor, record.length, true);
    buffer.set(record, recordOffset);
    cursor = recordOffset + record.length;
    return recordOffset;
  };

  const artistRecord = concat([
    new Uint8Array(4),
    utf8('Nine Inch Nails\0'),
    backwardsField(0x44, utf16('Nine Inch Nails.art\0')),
  ]);
  const artistOffset = writeRecord(artistRecord);

  const albumRecord = concat([
    (() => {
      const head = new Uint8Array(20);
      const headView = new DataView(head.buffer);
      headView.setUint32(0, artistId, true);
      headView.setBigUint64(12, dateToFiletime(new Date('2005-05-03T00:00:00Z')), true);
      return head;
    })(),
    utf8('With Teeth\0'),
    backwardsField(0x44, utf16('Nine Inch Nails--With Teeth.alb\0')),
  ]);
  const albumOffset = writeRecord(albumRecord);

  const genreOffset = writeRecord(concat([new Uint8Array([0]), utf8('Industrial\0')]));
  const filenameOffset = writeRecord(concat([new Uint8Array(8), utf8('01 All the Love in the World.mp3\0')]));

  const trackRecord = concat([
    (() => {
      const head = new Uint8Array(32);
      const headView = new DataView(head.buffer);
      headView.setUint32(0, albumId, true);
      headView.setUint32(4, artistId, true);
      headView.setUint32(8, genreId, true);
      headView.setUint32(12, filenameId, true);
      headView.setInt32(16, 296000, true);
      headView.setInt32(20, 7_340_032, true);
      headView.setUint16(24, 1, true);
      headView.setUint16(26, 12, true);
      headView.setUint16(28, 1, true);
      head[30] = 4;
      return head;
    })(),
    utf8('All the Love in the World\0'),
    backwardsField(0x6c, new Uint8Array([1, 0, 0, 0])),
  ]);
  const trackOffset = writeRecord(trackRecord);

  const offsets = [artistOffset, albumOffset, genreOffset, filenameOffset, trackOffset];
  indexIds.forEach((id, i) => {
    view.setUint32(indexOffset + i * 8, id, true);
    view.setUint32(indexOffset + i * 8 + 4, offsets[i], true);
  });

  descriptor(0, 8, indexIds.length, indexOffset);
  descriptor(1, 4, 1, musicEntriesOffset);
  view.setUint32(musicEntriesOffset, trackId, true);

  return buffer.slice(0, cursor);
}

function buildDeviceInfoDataset(): Uint8Array {
  const writer = new ZuneBinaryWriter(256);
  writer.writeUint16(100);
  writer.writeUint32(0x00000006);
  writer.writeUint16(100);
  writer.writeBytes(encodeMtpString('microsoft.com: 1.0'));
  writer.writeUint16(0);

  const writeArray = (values: number[]): void => {
    writer.writeUint32(values.length);
    for (const value of values) writer.writeUint32(value);
  };

  writeArray([OperationCode.GetDeviceInfo, OperationCode.OpenSession, OperationCode.SendObject]);
  writeArray([]);
  writeArray([]);
  writeArray([]);
  writeArray([0x3009]);

  writer.writeBytes(encodeMtpString('Microsoft'));
  writer.writeBytes(encodeMtpString('Zune HD'));
  writer.writeBytes(encodeMtpString('1.0'));
  writer.writeBytes(encodeMtpString('0123456789ABCDEF'));

  return writer.toUint8Array();
}

function buildStorageIdsDataset(): Uint8Array {
  const writer = new ZuneBinaryWriter(16);
  writer.writeUint32(1);
  writer.writeUint32(0x00010001);
  return writer.toUint8Array();
}

function buildStorageInfoDataset(): Uint8Array {
  const writer = new ZuneBinaryWriter(128);
  writer.writeUint16(0x0004);
  writer.writeUint16(0x0002);
  writer.writeUint16(0x0000);
  writer.writeUint64(32n * 1024n * 1024n * 1024n);
  writer.writeUint64(16n * 1024n * 1024n * 1024n);
  writer.writeUint64(1024n);
  writer.writeBytes(encodeMtpString('Zune HD'));
  writer.writeBytes(encodeMtpString('ZUNEHD'));
  return writer.toUint8Array();
}

function response(txid: number, code: number, params: number[] = []): Uint8Array {
  return buildContainer(ContainerType.RESPONSE, code, txid, params);
}

function queueChunked(transport: MemoryTransport, bytes: Uint8Array, chunkSize = 512): void {
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    transport.queueRead(bytes.slice(offset, Math.min(offset + chunkSize, bytes.length)));
  }
}

interface ScriptedDevice {
  transport: MemoryTransport;
  handles: number[];
  commands: number[];
}

function createScriptedDevice(options: { mtpzResponse?: (message: Uint8Array) => Uint8Array } = {}): ScriptedDevice {
  const transport = new MemoryTransport();
  const handles: number[] = [];
  const commands: number[] = [];
  let nextHandle = 0x4000;
  let pendingData: Uint8Array | null = null;
  let payloadRemaining = 0;

  transport.onWrite = (data) => {
    if (payloadRemaining > 0) {
      payloadRemaining -= data.length;
      pendingData = data;
      return;
    }
    if (data.length < 12) return;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const type = view.getUint16(4, true);
    const code = view.getUint16(6, true);
    const txid = view.getUint32(8, true);

    if (type === ContainerType.DATA) {
      pendingData = data.slice(12);
      payloadRemaining = Math.max(0, view.getUint32(0, true) - 12) - pendingData.length;
      return;
    }
    if (type !== ContainerType.COMMAND) return;

    commands.push(code);

    switch (code) {
      case OperationCode.OpenSession:
      case OperationCode.CloseSession:
      case OperationCode.SetDevicePropValue:
      case OperationCode.SetObjectPropValue:
      case OperationCode.SendObject:
      case OperationCode.DeleteObject:
      case OperationCode.SyncDeviceDB:
      case OperationCode.DisableTrustedFiles:
      case OperationCode.EndTrustedAppSession:
      case OperationCode.EnableTrustedFilesOperations:
      case OperationCode.RegisterTrackContext:
        transport.queueRead(response(txid, ResponseCode.OK));
        break;
      case OperationCode.GetDeviceInfo:
        transport.queueRead(buildDataContainer(code, txid, buildDeviceInfoDataset()));
        transport.queueRead(response(txid, ResponseCode.OK));
        break;
      case OperationCode.GetStorageIDs:
        transport.queueRead(buildDataContainer(code, txid, buildStorageIdsDataset()));
        transport.queueRead(response(txid, ResponseCode.OK));
        break;
      case OperationCode.GetStorageInfo:
        transport.queueRead(buildDataContainer(code, txid, buildStorageInfoDataset()));
        transport.queueRead(response(txid, ResponseCode.OK));
        break;
      case OperationCode.SendObjectInfo: {
        nextHandle += 0x10;
        handles.push(nextHandle);
        const storageId = view.getUint32(12, true);
        const parent = view.getUint32(16, true);
        transport.queueRead(response(txid, ResponseCode.OK, [storageId, parent, nextHandle]));
        break;
      }
      case OperationCode.SendObjectPropList: {
        nextHandle += 0x10;
        handles.push(nextHandle);
        transport.queueRead(response(txid, ResponseCode.OK, [0x00010001, 0, nextHandle]));
        break;
      }
      case OperationCode.SendWMDRMPDAppRequest:
        transport.queueRead(response(txid, ResponseCode.OK));
        break;
      case OperationCode.GetWMDRMPDAppResponse: {
        const payload = options.mtpzResponse?.(pendingData ?? new Uint8Array(0)) ?? new Uint8Array(0);
        queueChunked(transport, buildDataContainer(code, txid, payload));
        transport.queueRead(response(txid, ResponseCode.OK));
        break;
      }
      default:
        transport.queueRead(response(txid, ResponseCode.OperationNotSupported));
        break;
    }
  };

  return { transport, handles, commands };
}

function buildMtpzDeviceResponse(sentMessage: Uint8Array, macHash: Uint8Array): Uint8Array {
  const certsLength = MTPZ_CERTIFICATES.length;
  const randomOffset = 5 + 2 + certsLength + 2;
  const sentRandom = sentMessage.slice(randomOffset, randomOffset + 16);

  const sessionKey = new Uint8Array(randomBytes(16));
  const data = new Uint8Array(107);
  data.set(sessionKey, 91);

  const seed = new Uint8Array(randomBytes(20));
  const dataMask = mgf1Sha1(seed, 107);
  const maskedData = new Uint8Array(107);
  for (let i = 0; i < 107; i++) maskedData[i] = data[i] ^ dataMask[i];

  const seedMask = mgf1Sha1(maskedData, 20);
  const maskedSeed = new Uint8Array(20);
  for (let i = 0; i < 20; i++) maskedSeed[i] = seed[i] ^ seedMask[i];

  const block = new Uint8Array(128);
  block.set(maskedSeed, 1);
  block.set(maskedData, 21);

  const encryptedBlock = rsaRawPublic(block);

  const plaintextParts: Uint8Array[] = [new Uint8Array([0x00])];
  const certsLengthBytes = new Uint8Array(4);
  new DataView(certsLengthBytes.buffer).setUint32(0, certsLength, false);
  plaintextParts.push(certsLengthBytes, MTPZ_CERTIFICATES);
  plaintextParts.push(new Uint8Array([0x00, 0x10]), sentRandom);
  plaintextParts.push(new Uint8Array([0x00, 0x04]), new Uint8Array([1, 2, 3, 4]));
  plaintextParts.push(new Uint8Array([0x01, 0x00, 0x02]), new Uint8Array([0xaa, 0xbb]));
  plaintextParts.push(new Uint8Array([0x01, 0x00, macHash.length]), macHash);

  const plaintext = concat(plaintextParts);
  const padded = new Uint8Array(Math.ceil(plaintext.length / 16) * 16);
  padded.set(plaintext);
  const cipher = createCipheriv('aes-128-cbc', sessionKey, new Uint8Array(16));
  cipher.setAutoPadding(false);
  const ciphertext = new Uint8Array(Buffer.concat([cipher.update(padded), cipher.final()]));

  const header = new Uint8Array(136);
  header[0] = 0x02;
  header[1] = 0x02;
  header[2] = 0x00;
  header[3] = 0x80;
  header.set(encryptedBlock, 4);
  new DataView(header.buffer).setUint16(134, ciphertext.length, false);

  return concat([header, ciphertext]);
}

async function main(): Promise<void> {
  console.log('zunesync-ts validation\n');

  console.log('common');
  await test('binary reader/writer round-trip', () => {
    const writer = new ZuneBinaryWriter(16);
    writer.writeUint8(0x12);
    writer.writeUint16(0x3456);
    writer.writeUint32(0x789abcde);
    writer.writeUint64(0x0102030405060708n);
    writer.writeAscii('ZMDB');
    writer.writeUtf16le('Zune');

    const reader = new ZuneBinaryReader(writer.finalize());
    assert.equal(reader.readUint8(), 0x12);
    assert.equal(reader.readUint16(), 0x3456);
    assert.equal(reader.readUint32(), 0x789abcde);
    assert.equal(reader.readUint64(), 0x0102030405060708n);
    assert.equal(reader.readAscii(4), 'ZMDB');
    assert.equal(reader.readUtf16le(8), 'Zune');
    assert.equal(reader.remaining, 0);
  });

  await test('FILETIME conversion', () => {
    const date = new Date('2005-05-03T12:34:56Z');
    assert.equal(filetimeToDate(dateToFiletime(date))?.toISOString(), date.toISOString());
    assert.equal(filetimeToDate(0n), null);
  });

  await test('zuneSafeName and formatDateAuthored', () => {
    assert.equal(zuneSafeName('a/b:c*d?.mp3'), 'a b c d .mp3');
    assert.equal(zuneSafeName(''), 'Untitled');
    assert.equal(formatDateAuthored(new Date(2024, 0, 2, 3, 4, 5)), '20240102T030405.0');
    assert.equal(formatDateAuthored(null), '');
  });

  await test('stripHtml', () => {
    assert.equal(stripHtml('<p>Hello&nbsp;<b>world</b></p>'), 'Hello world');
  });

  console.log('\nzmdb');
  await test('backwards varints decode in record order', () => {
    const record = concat([
      new Uint8Array(8),
      backwardsField(0x41, utf16('first')),
      backwardsField(0x44, utf16('second')),
    ]);
    const fields = parseBackwardsVarints(record, 8);
    assert.equal(fields.length, 2);
    assert.equal(fields[0].fieldId, 0x41);
    assert.equal(fields[1].fieldId, 0x44);
    assert.equal(Buffer.from(fields[1].data).toString('utf16le'), 'second');
  });

  await test('ZMDB header and descriptors', () => {
    const db = new ZMDB(buildZmdb(), 'hd');
    db.parse();
    const header = db.header;
    assert.equal(header.zmedVersion, 5);
    assert.equal(header.deviceFamily, 'hd');
    assert.equal(header.zarrOffset, 0x30);
    assert.equal(header.descriptorCount, 96);
    assert.equal(header.indexEntryCount, 5);
  });

  await test('ZMDB parses a track with resolved references', () => {
    const library = parseDatabase(buildZmdb(), 'hd');
    assert.equal(library.tracks.length, 1);
    const track = library.tracks[0];
    assert.equal(track.title, 'All the Love in the World');
    assert.equal(track.artist, 'Nine Inch Nails');
    assert.equal(track.album, 'With Teeth');
    assert.equal(track.albumArtist, 'Nine Inch Nails');
    assert.equal(track.genre, 'Industrial');
    assert.equal(track.duration, 296000);
    assert.equal(track.size, 7_340_032);
    assert.equal(track.trackNumber, 1);
    assert.equal(track.discNumber, 1);
    assert.equal(track.playcount, 12);
    assert.equal(track.filename, '01 All the Love in the World.mp3');
  });

  await test('ZMDB resolves album year and artist filename', () => {
    const db = new ZMDB(buildZmdb(), 'hd');
    const library = db.parse();
    const album = library.albums[0x06000001];
    assert.equal(album.releaseYear, 2005);
    assert.equal(album.filename, 'Nine Inch Nails--With Teeth.alb');
    const artist = library.artists[0x08000001];
    assert.equal(artist.name, 'Nine Inch Nails');
    assert.equal(artist.filename, 'Nine Inch Nails.art');
  });

  await test('ZMDB rejects a non-ZMDB buffer', () => {
    assert.throws(() => parseDatabase(new Uint8Array(64)), /Not a ZMDB/);
  });

  console.log('\nmtp');
  await test('container round-trip', () => {
    const command = buildContainer(ContainerType.COMMAND, OperationCode.GetObjectHandles, 7, [1, 2, 3]);
    const parsed = parseContainer(command);
    assert.equal(parsed.type, ContainerType.COMMAND);
    assert.equal(parsed.code, OperationCode.GetObjectHandles);
    assert.equal(parsed.transactionId, 7);
    assert.deepEqual(parsed.params, [1, 2, 3]);

    const data = buildDataContainer(OperationCode.GetObject, 9, new Uint8Array([1, 2, 3, 4]));
    const parsedData = parseContainer(data);
    assert.equal(parsedData.type, ContainerType.DATA);
    assert.deepEqual(Array.from(parsedData.payload), [1, 2, 3, 4]);
  });

  await test('MTP string round-trip', () => {
    const encoded = encodeMtpString('Zune HD');
    const decoded = decodeMtpString(encoded);
    assert.equal(decoded.value, 'Zune HD');
    assert.equal(decoded.offset, encoded.length);
  });

  await test('property list encodes handle, code, type and value', () => {
    const payload = encodePropList(
      [
        { property: ObjectProperty.Name, type: DataType.STR, value: 'Song' },
        { property: ObjectProperty.Track, type: DataType.UINT32, value: 3 },
      ],
      0x1234,
    );
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    assert.equal(view.getUint32(0, true), 2);
    assert.equal(view.getUint32(4, true), 0x1234);
    // The property code is 16 bits: an 8-byte head, not 10.
    assert.equal(view.getUint16(8, true), ObjectProperty.Name);
    assert.equal(view.getUint16(10, true), DataType.STR);
  });

  await test('property list element head is 8 bytes and elements are contiguous', () => {
    const payload = encodePropList(
      [
        { property: ObjectProperty.Name, type: DataType.STR, value: 'A' },
        { property: ObjectProperty.Track, type: DataType.UINT32, value: 7 },
      ],
      0,
    );
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

    // 4 count + (8 head + 1 len + 2 chars + 2 nul) + (8 head + 4 value)
    assert.equal(payload.length, 29);
    assert.equal(view.getUint16(17 + 4, true), ObjectProperty.Track);
    assert.equal(view.getUint16(17 + 6, true), DataType.UINT32);
    assert.equal(view.getUint32(17 + 8, true), 7);
  });

  await test('AUINT16 string encodes as UTF-16LE with a NUL and a code-unit count', () => {
    const payload = encodePropList(
      [{ property: ObjectProperty.URLSource, type: DataType.AUINT16, value: 'http://a/b' }],
      0,
    );
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

    const count = view.getUint32(12, true);
    assert.equal(count, 11);
    assert.equal(payload.length, 4 + 8 + 4 + 11 * 2);

    let text = '';
    for (let i = 0; i < count; i++) text += String.fromCharCode(view.getUint16(16 + i * 2, true));
    assert.equal(text, 'http://a/b\0');
  });

  await test('protocol reads device info over a scripted transport', async () => {
    const device = createScriptedDevice();
    const protocol = new MtpProtocol(device.transport);
    await protocol.openSession();
    const info = await protocol.getDeviceInfo();
    assert.equal(info.model, 'Zune HD');
    assert.equal(info.manufacturer, 'Microsoft');
    assert.equal(info.serialNumber, '0123456789ABCDEF');
    assert.ok(info.operationsSupported.includes(OperationCode.SendObject));
  });

  await test('protocol surfaces device rejections with params', async () => {
    const transport = new MemoryTransport();
    transport.onWrite = (data) => {
      if (data.length < 12) return;
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      transport.queueRead(response(view.getUint32(8, true), 0xa801, [2]));
    };
    const protocol = new MtpProtocol(transport);
    await assert.rejects(
      () => protocol.transaction(OperationCode.SendObjectPropList, [1, 0, 0x3009, 0, 0], new Uint8Array(4)),
      (error: Error & { code?: string; params?: number[] }) =>
        error.code === 'MTP_RESPONSE' && error.params?.[0] === 0xa801 && error.params?.[1] === 2,
    );
  });

  console.log('\ncrypto');
  await test('AES-128 matches the FIPS-197 C.1 block vector', () => {
    const key = fromHex('000102030405060708090a0b0c0d0e0f');
    const plaintext = fromHex('00112233445566778899aabbccddeeff');
    assert.equal(hex(aesEncryptBlock(key, plaintext)), '69c4e0d86a7b0430d8cdb78070b4c55a');
    assert.equal(hex(aesDecryptBlock(key, fromHex('69c4e0d86a7b0430d8cdb78070b4c55a'))), hex(plaintext));
  });

  await test('AES-128-ECB matches the NIST SP 800-38A vector', () => {
    const key = fromHex('2b7e151628aed2a6abf7158809cf4f3c');
    assert.equal(
      hex(aesEcbEncrypt(key, fromHex('6bc1bee22e409f96e93d7e117393172a'))),
      '3ad77bb40d7a3660a89ecaf32466ef97',
    );
  });

  await test('AES-128-CBC matches the NIST SP 800-38A vector', () => {
    const key = fromHex('2b7e151628aed2a6abf7158809cf4f3c');
    const iv = fromHex('000102030405060708090a0b0c0d0e0f');
    const plaintext = fromHex('6bc1bee22e409f96e93d7e117393172a');
    const ciphertext = aesCbcEncrypt(key, iv, plaintext);
    assert.equal(hex(ciphertext), '7649abac8119b246cee98e9b12e9197d');
    assert.equal(hex(aesCbcDecrypt(key, iv, ciphertext)), hex(plaintext));
  });

  await test('SHA-1 matches the RFC 3174 vectors', () => {
    assert.equal(hex(sha1(new Uint8Array(0))), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
    assert.equal(hex(sha1(new Uint8Array([0x61, 0x62, 0x63]))), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  });

  await test('getRandomBytes uses the platform CSPRNG', () => {
    const first = getRandomBytes(16);
    assert.equal(first.length, 16);
    assert.notEqual(hex(first), hex(getRandomBytes(16)));
  });

  console.log('\nmtpz');
  await test('AES-CMAC matches RFC 4493 vectors', () => {
    const key = fromHex('2b7e151628aed2a6abf7158809cf4f3c');
    assert.equal(hex(aesCmac(key, new Uint8Array(0))), 'bb1d6929e95937287fa37d129b756746');
    assert.equal(
      hex(aesCmac(key, fromHex('6bc1bee22e409f96e93d7e117393172a'))),
      '070a16b46b4d4144f79bdd9dd04a287c',
    );
    assert.equal(
      hex(
        aesCmac(
          key,
          fromHex('6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411'),
        ),
      ),
      'dfa66747de9ae63030ca32611497c827',
    );
  });

  await test('RSA private and public operations are inverses', () => {
    const message = new Uint8Array(128);
    message[0] = 0x01;
    message[127] = 0x42;
    const signed = rsaRawPrivate(message);
    assert.equal(hex(rsaRawPublic(signed)), hex(message));
  });

  await test('MTPZ handshake completes against a simulated device', async () => {
    const macHash = new Uint8Array(randomBytes(20));
    const device = createScriptedDevice({
      mtpzResponse: (message) => buildMtpzDeviceResponse(message, macHash),
    });
    const protocol = new MtpProtocol(device.transport);
    const auth = new MtpzAuth(protocol);
    const session = await auth.authenticate();
    assert.equal(hex(session.macHash), hex(macHash));
    assert.deepEqual(device.commands, [
      OperationCode.SetDevicePropValue,
      OperationCode.EndTrustedAppSession,
      OperationCode.SendWMDRMPDAppRequest,
      OperationCode.GetWMDRMPDAppResponse,
      OperationCode.SendWMDRMPDAppRequest,
      OperationCode.EnableTrustedFilesOperations,
    ]);
  });

  await test('MTPZ rejects a mismatched echoed random', async () => {
    const macHash = new Uint8Array(randomBytes(20));
    const device = createScriptedDevice({
      mtpzResponse: (message) => {
        const tampered = message.slice();
        tampered[5 + 2 + MTPZ_CERTIFICATES.length + 2] ^= 0xff;
        return buildMtpzDeviceResponse(tampered, macHash);
      },
    });
    const auth = new MtpzAuth(new MtpProtocol(device.transport));
    await assert.rejects(() => auth.authenticate(), /echoed random/);
  });

  console.log('\nzune');
  await test('model detection resolves capacity within a family product id', () => {
    // 0x0710 is the whole classic family: 4, 8, 16, 30, 80 and 120 GB.
    assert.equal(detectDevice(0x0710, 8_000_000_000).name, 'Zune 8');
    assert.equal(detectDevice(0x0710, 30_000_000_000).name, 'Zune 30');
    assert.equal(detectDevice(0x0710, 120_000_000_000).name, 'Zune 120');
    // Real devices report slightly under the nominal capacity.
    assert.equal(detectDevice(0x0710, 7_995_899_904).name, 'Zune 8');
    // Without a capacity the family default is returned, never a wrong model.
    assert.equal(detectDevice(0x0710).name, 'Zune 4');
    assert.equal(detectDevice('0x0710').family, 'classic');
    assert.equal(detectDevice(0x063e, 32_000_000_000).name, 'Zune HD 32');
    assert.equal(detectDevice(0x063e).family, 'hd');
    assert.equal(getZuneModelVariants(0x0710).length, 6);
    assert.equal(getZuneModelVariants(0x063e).length, 3);
    assert.equal(Object.keys(ZUNE_MODELS).length, 2);
    assert.equal(isZuneProductId(0x0710), true);
    assert.equal(isZuneProductId(0x1234), false);
    assert.throws(() => detectDevice(0x1234), /Unknown Zune product ID/);
  });

  await test('filename helpers', () => {
    assert.equal(formatForFilename('song.m4a'), 0xb903);
    assert.equal(formatForFilename('song.unknown'), 0x3009);
    assert.equal(stripExtension('01 Song.mp3'), '01 Song');
  });

  await test('Zune connects, uploads tracks and flushes the database', async () => {
    const device = createScriptedDevice();
    const zune = await Zune.open({ transport: device.transport, productId: 0x063e, authenticate: false });

    assert.equal(zune.connected, true);
    assert.equal(zune.storageId, 0x00010001);
    assert.equal(zune.deviceInfo?.model, 'Zune HD');
    assert.equal(zune.storageInfo?.volumeLabel, 'ZUNEHD');
    assert.equal(zune.family, 'hd');

    const session = zune.createSession();
    const handles = await session.run(async (active) =>
      zune.uploadTracks(
        [
          {
            data: new Uint8Array(1024),
            filename: '01 All the Love in the World.mp3',
            metadata: {
              albumName: 'With Teeth',
              albumArtist: 'Nine Inch Nails',
              artist: 'Nine Inch Nails',
              genre: 'Industrial',
              track: 1,
              duration: 296000,
            },
          },
          {
            data: new Uint8Array(2048),
            filename: '02 You Know What You Are.mp3',
            metadata: {
              albumName: 'With Teeth',
              albumArtist: 'Nine Inch Nails',
              artist: 'Nine Inch Nails',
              genre: 'Industrial',
              track: 2,
              duration: 220000,
            },
          },
        ],
        { session: active, registerTrackContext: true },
      ),
    );

    assert.equal(handles.length, 2);
    assert.equal(session.handles.length, 4);
    assert.equal(session.isActive, false);

    await zune.syncDeviceDB(1);
    await zune.setBookmark(handles[0], 42000);
    await zune.deleteObject(handles[0]);
    await zune.disconnect();

    assert.equal(zune.connected, false);
    assert.ok(device.commands.includes(OperationCode.SendObjectInfo));
    assert.ok(device.commands.includes(OperationCode.RegisterTrackContext));
    assert.ok(device.commands.includes(OperationCode.SyncDeviceDB));
    assert.ok(device.commands.includes(OperationCode.SetObjectPropValue));
    assert.ok(device.commands.includes(OperationCode.DeleteObject));
    assert.ok(device.commands.includes(OperationCode.CloseSession));
  });

  await test('ZuneSync rolls back created handles on failure', async () => {
    const device = createScriptedDevice();
    const zune = await Zune.open({ transport: device.transport, authenticate: false });
    const session = zune.createSession();

    await assert.rejects(() =>
      session.run(async (active) => {
        await zune.createArtist('Nine Inch Nails', { session: active });
        throw new Error('boom');
      }),
    );

    assert.equal(session.isActive, false);
    assert.equal(session.handles.length, 0);
    assert.ok(device.commands.includes(OperationCode.DeleteObject));
  });

  await test('Zune reads and parses the device ZMDB', async () => {
    const zmdb = buildZmdb();
    const device = createScriptedDevice();
    const transport = device.transport;
    const inner = transport.onWrite!;

    transport.onWrite = (data, target) => {
      if (data.length === 16 && data[6] === 0x17 && data[7] === 0x92) {
        const header = new Uint8Array(12);
        new DataView(header.buffer).setUint32(0, 12 + zmdb.length, true);
        transport.queueRead(concat([header, zmdb]));
        return;
      }
      inner(data, target);
    };

    const zune = await Zune.open({ transport, authenticate: false, zmdbSettleMs: 0 });
    const library = await zune.readDatabase();
    assert.equal(library.tracks.length, 1);
    assert.equal(library.tracks[0].title, 'All the Love in the World');
    assert.equal(library.tracks[0].artist, 'Nine Inch Nails');
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
  }
}

await main();
