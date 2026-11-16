import { ZuneBinaryReader } from '../../common/binary/reader.js';
import { ZuneBinaryWriter } from '../../common/binary/writer.js';
import { decodeMtpString, encodeMtpString } from '../container/index.js';
import type { MtpDeviceInfo, MtpStorageInfo } from '../types.js';

function readUint32Array(reader: ZuneBinaryReader): number[] {
  if (reader.remaining < 4) return [];
  const count = reader.readUint32();
  const values: number[] = [];
  for (let i = 0; i < count && reader.remaining >= 4; i++) values.push(reader.readUint32());
  return values;
}

function readString(reader: ZuneBinaryReader): string {
  const { value, offset } = decodeMtpString(reader.buffer, reader.offset);
  reader.seek(offset);
  return value;
}

/** Decode a `GetDeviceInfo` dataset. */
export function parseDeviceInfo(payload: Uint8Array): MtpDeviceInfo {
  const reader = new ZuneBinaryReader(payload);

  const standardVersion = reader.readUint16();
  const vendorExtensionId = reader.readUint32();
  const vendorExtensionVersion = reader.readUint16();
  const vendorExtensionDesc = readString(reader);
  const functionalMode = reader.readUint16();

  return {
    standardVersion,
    vendorExtensionId,
    vendorExtensionVersion,
    vendorExtensionDesc,
    functionalMode,
    operationsSupported: readUint32Array(reader),
    eventsSupported: readUint32Array(reader),
    devicePropertiesSupported: readUint32Array(reader),
    captureFormats: readUint32Array(reader),
    playbackFormats: readUint32Array(reader),
    manufacturer: readString(reader),
    model: readString(reader),
    deviceVersion: readString(reader),
    serialNumber: readString(reader),
  };
}

/** Decode a `GetStorageInfo` dataset. */
export function parseStorageInfo(payload: Uint8Array): MtpStorageInfo {
  const reader = new ZuneBinaryReader(payload);

  const storageType = reader.readUint16();
  const filesystemType = reader.readUint16();
  const accessCapability = reader.readUint16();
  const maxCapacity = reader.readUint64();
  const freeSpaceInBytes = reader.readUint64();
  const freeSpaceInObjects = reader.readUint64();

  return {
    storageType,
    filesystemType,
    accessCapability,
    maxCapacity,
    freeSpaceInBytes,
    freeSpaceInObjects,
    storageDescription: readString(reader),
    volumeLabel: readString(reader),
  };
}

/** Decode a `GetObjectInfo` dataset. */
export function parseObjectInfo(payload: Uint8Array): {
  storageId: number;
  objectFormat: number;
  protectionStatus: number;
  compressedSize: number;
  parentObject: number;
  filename: string;
} {
  const reader = new ZuneBinaryReader(payload);

  const storageId = reader.readUint32();
  const objectFormat = reader.readUint16();
  const protectionStatus = reader.readUint16();
  const compressedSize = reader.readUint32();

  reader.skip(26);

  const parentObject = reader.readUint32();
  reader.skip(10);

  return {
    storageId,
    objectFormat,
    protectionStatus,
    compressedSize,
    parentObject,
    filename: readString(reader),
  };
}

/** Build a `SendObjectInfo` dataset (52 fixed bytes plus three MTP strings). */
export function buildObjectInfoDataset(info: {
  storageId: number;
  objectFormat: number;
  compressedSize: number;
  parentObject: number;
  filename: string;
}): Uint8Array {
  const filename = encodeMtpString(info.filename);
  const empty = new Uint8Array([0x00]);
  const writer = new ZuneBinaryWriter(52 + filename.length + 2);

  writer.writeUint32(info.storageId);
  writer.writeUint16(info.objectFormat);
  writer.writeUint16(0);
  writer.writeUint32(info.compressedSize);
  writer.writeUint16(0);
  writer.writeUint32(0);
  writer.writeUint32(0);
  writer.writeUint32(0);
  writer.writeUint32(0);
  writer.writeUint32(0);
  writer.writeUint32(0);
  writer.writeUint32(info.parentObject);
  writer.writeUint16(0);
  writer.writeUint32(0);
  writer.writeUint32(0);
  writer.writeBytes(filename);
  writer.writeBytes(empty);
  writer.writeBytes(empty);

  return writer.toUint8Array();
}
