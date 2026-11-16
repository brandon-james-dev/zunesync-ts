import type { MtpDataType } from './constants/index.js';

/** A decoded MTP container. */
export interface MtpContainer {
  /** Declared total length, including the 12-byte header. */
  length: number;
  /** One of {@link ContainerType}. */
  type: number;
  /** Operation, response or event code. */
  code: number;
  transactionId: number;
  /** Operation parameters (command) or response parameters (response). */
  params: number[];
  /** Bytes after the parameter list. */
  payload: Uint8Array;
}

/** One property value inside a property list. */
export interface MtpPropValue {
  property: number;
  type: MtpDataType;
  value: string | number | bigint | Uint8Array;
}

/** A property-list entry: object handle plus its property values. */
export interface MtpPropListEntry {
  handle: number;
  props: MtpPropValue[];
}

/** Facts from `GetDeviceInfo`. */
export interface MtpDeviceInfo {
  standardVersion: number;
  vendorExtensionId: number;
  vendorExtensionVersion: number;
  vendorExtensionDesc: string;
  functionalMode: number;
  operationsSupported: number[];
  eventsSupported: number[];
  devicePropertiesSupported: number[];
  captureFormats: number[];
  playbackFormats: number[];
  manufacturer: string;
  model: string;
  deviceVersion: string;
  serialNumber: string;
}

/** Facts from `GetStorageInfo`. */
export interface MtpStorageInfo {
  storageType: number;
  filesystemType: number;
  accessCapability: number;
  maxCapacity: bigint;
  freeSpaceInBytes: bigint;
  freeSpaceInObjects: bigint;
  storageDescription: string;
  volumeLabel: string;
}

/** Metadata attached to an uploaded object. */
export interface MtpObjectMetadata {
  name?: string;
  artist?: string;
  albumName?: string;
  albumArtist?: string;
  genre?: string;
  track?: number;
  duration?: number;
  dateAuthored?: string;
  originalDate?: string;
  metaGenre?: number;
  artistId?: number;
  seriesName?: string;
  seriesHandle?: number;
  urlSource?: string;
  timeBookmark?: number;
  description?: string;
  isPodcast?: boolean;
  albumArt?: {
    data: Uint8Array;
    format?: number;
    width?: number;
    height?: number;
  };
}

/** Progress callback for object transfers. */
export type MtpProgressCallback = (sent: number, total: number) => void;
