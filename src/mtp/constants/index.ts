/** MTP container types (the `type` field of every 12-byte header). */
export const ContainerType = {
  COMMAND: 0x0001,
  DATA: 0x0002,
  RESPONSE: 0x0003,
  EVENT: 0x0004,
} as const;

export type MtpContainerType = (typeof ContainerType)[keyof typeof ContainerType];

/** MTP operation codes, including the Zune/WMDRMPD vendor extensions. */
export const OperationCode = {
  GetDeviceInfo: 0x1001,
  OpenSession: 0x1002,
  CloseSession: 0x1003,
  GetStorageIDs: 0x1004,
  GetStorageInfo: 0x1005,
  GetNumObjects: 0x1006,
  GetObjectHandles: 0x1007,
  GetObjectInfo: 0x1008,
  GetObject: 0x1009,
  GetThumb: 0x100a,
  DeleteObject: 0x100b,
  SendObjectInfo: 0x100c,
  SendObject: 0x100d,
  GetDevicePropValue: 0x1015,
  SetDevicePropValue: 0x1016,
  GetObjectPropsSupported: 0x9801,
  GetObjectPropDesc: 0x9802,
  GetObjectPropValue: 0x9803,
  SetObjectPropValue: 0x9804,
  GetObjectPropList: 0x9805,
  SendObjectPropList: 0x9808,
  GetObjectReferences: 0x9810,
  SetObjectReferences: 0x9811,
  SendWMDRMPDAppRequest: 0x9212,
  GetWMDRMPDAppResponse: 0x9213,
  EnableTrustedFilesOperations: 0x9214,
  DisableTrustedFiles: 0x9215,
  EndTrustedAppSession: 0x9216,
  SyncDeviceDB: 0x9217,
  RegisterTrackContext: 0x922a,
} as const;

export type MtpOperationCode = (typeof OperationCode)[keyof typeof OperationCode];

/** MTP response codes. `OK` is `0x2001`; everything else is a rejection. */
export const ResponseCode = {
  OK: 0x2001,
  GeneralError: 0x2002,
  SessionNotOpen: 0x2003,
  InvalidTransactionID: 0x2004,
  OperationNotSupported: 0x2005,
  ParameterNotSupported: 0x2006,
  InvalidStorageID: 0x2008,
  InvalidObjectHandle: 0x2009,
  StoreFull: 0x200c,
  ObjectWriteProtected: 0x200d,
  InvalidParameter: 0x201d,
  SessionAlreadyOpen: 0x201e,
} as const;

export type MtpResponseCode = (typeof ResponseCode)[keyof typeof ResponseCode];

/** Object format codes used by the Zune. */
export const ObjectFormat = {
  Undefined: 0x3000,
  Association: 0x3001,
  MP3: 0x3009,
  JPEG: 0x3801,
  WMA: 0xb901,
  AAC: 0xb903,
  WMV: 0xb981,
  MP4: 0xb982,
  AbstractAudioAlbum: 0xba03,
  PodcastSeries: 0xba0b,
  Artist: 0xb218,
} as const;

export type MtpObjectFormat = (typeof ObjectFormat)[keyof typeof ObjectFormat];

/** Map a file extension (lower-case, with dot) to an MTP object format. */
export const ExtensionToFormat: Record<string, number> = {
  '.mp3': ObjectFormat.MP3,
  '.wma': ObjectFormat.WMA,
  '.aac': ObjectFormat.AAC,
  '.m4a': ObjectFormat.AAC,
  '.wmv': ObjectFormat.WMV,
  '.mp4': ObjectFormat.MP4,
  '.m4v': ObjectFormat.MP4,
  '.jpg': ObjectFormat.JPEG,
  '.jpeg': ObjectFormat.JPEG,
};

/** Device properties. */
export const DeviceProperty = {
  SessionInitiatorInfo: 0xd406,
} as const;

/** Object properties written by the sync engine. */
export const ObjectProperty = {
  Name: 0xdc44,
  Artist: 0xdc46,
  DateAuthored: 0xdc47,
  Description: 0xdc48,
  Duration: 0xdc89,
  Track: 0xdc8b,
  Genre: 0xdc8c,
  MetaGenre: 0xdc95,
  OriginalDate: 0xdc99,
  AlbumName: 0xdc9a,
  AlbumArtist: 0xdc9b,
  RepresentativeSampleFormat: 0xdc81,
  RepresentativeSampleSize: 0xdc82,
  RepresentativeSampleHeight: 0xdc83,
  RepresentativeSampleWidth: 0xdc84,
  RepresentativeSampleData: 0xdc86,
  StorageID: 0xdc01,
  ObjectFileName: 0xdc07,
  ArtistId: 0xdab9,
  SeriesName: 0xda9a,
  PodcastDA9B: 0xda9b,
  IsPodcast: 0xda9c,
  PodcastDA9D: 0xda9d,
  SeriesHandle: 0xda9e,
  URLSource: 0xdd60,
  TimeBookmark: 0xdd62,
} as const;

/** `MetaGenre` values that tell the device which library a track belongs to. */
export const MetaGenre = {
  Music: 1,
  AudioPodcast: 64,
  VideoPodcast: 65,
} as const;

/** MTP property data types, as used in property lists. */
export const DataType = {
  INT8: 0x0001,
  UINT8: 0x0002,
  INT16: 0x0003,
  UINT16: 0x0004,
  INT32: 0x0005,
  UINT32: 0x0006,
  INT64: 0x0007,
  UINT64: 0x0008,
  INT128: 0x0009,
  UINT128: 0x000a,
  AUINT8: 0xffff,
  AUINT16: 0x4004,
  AUINT32: 0xfffd,
  AUINT64: 0xfffc,
  STR: 0xffff,
  DATETIME: 0x4008,
} as const;

export type MtpDataType = (typeof DataType)[keyof typeof DataType];
