import { ZuneError } from '../common/errors/index.js';
import { parseDatabase } from '../zmdb/database/parseDatabase.js';
import type { ZmdbLibrary } from '../zmdb/types.js';
import { DataType, ExtensionToFormat, ObjectFormat, ObjectProperty } from '../mtp/constants/index.js';
import { MtpProtocol } from '../mtp/protocol/MtpProtocol.js';
import { MtpzAuth } from '../mtp/auth/MtpzAuth.js';
import { UsbTransport } from '../mtp/transport/UsbTransport.js';
import type { MtpTransport } from '../mtp/transport/types.js';
import type {
  MtpDeviceInfo,
  MtpObjectMetadata,
  MtpProgressCallback,
  MtpPropValue,
  MtpStorageInfo,
} from '../mtp/types.js';
import { detectDevice } from '../device/detectDevice.js';
import type { ZuneModel, ZuneModelFamily } from '../device/types.js';
import { ZuneSync } from './ZuneSync.js';
import {
  buildAlbumProps,
  buildArtistProps,
  buildEpisodeProps,
  buildPodcastSeriesProps,
  buildTrackProps,
} from './props.js';

/** Options for {@link Zune.open}. */
export interface ZuneOptions {
  /** Pre-built transport. When omitted a {@link UsbTransport} is opened. */
  transport?: MtpTransport;
  /** USB product ID to open when using the default USB transport. */
  productId?: number;
  /** Storage ID to use. Defaults to the first storage the device reports. */
  storageId?: number;
  /** MTP session ID. Defaults to 1. */
  sessionId?: number;
  /** Run the MTPZ handshake. Defaults to true; set false for scripted transports. */
  authenticate?: boolean;
  /** Payload chunk size for bulk transfers. */
  chunkSize?: number;
  /** Milliseconds to wait after a ZMDB request before reading. */
  zmdbSettleMs?: number;
  /** Per-transaction response timeout in milliseconds. */
  responseTimeoutMs?: number;
  /** Diagnostic sink. */
  logger?: (message: string) => void;
}

/** One track to upload. */
export interface ZuneTrackUpload {
  /** Encoded audio bytes. */
  data: Uint8Array;
  /** Destination filename, including extension. */
  filename: string;
  /** MTP object format. Inferred from the extension when omitted. */
  format?: number;
  /** Tags written as object properties. */
  metadata?: MtpObjectMetadata;
  /** Progress callback for this track. */
  onProgress?: MtpProgressCallback;
}

/** Options shared by upload helpers. */
export interface ZuneUploadOptions {
  /** Parent folder handle. Defaults to the storage root (0). */
  parentHandle?: number;
  /** Session that records created handles for rollback. */
  session?: ZuneSync;
  /** Progress callback applied to every track. */
  onProgress?: MtpProgressCallback;
  /** Send `RegisterTrackContext` before each album's first track. */
  registerTrackContext?: boolean;
  /**
   * Called when a container object (artist, album) is rejected. The transfer
   * continues without it; the tracks themselves are unaffected.
   */
  onWarning?: (what: string, error: unknown) => void;
  /**
   * Called after each track object is written, with the running count and the
   * total. Without it a caller can only report progress once every upload has
   * finished, so the UI sits at zero and then jumps to the total.
   */
  onTrackUploaded?: (completed: number, total: number) => void;
}

/** A podcast series (`.ser`) object to create. */
export interface ZunePodcastSeries {
  name: string;
  feedUrl?: string;
  author?: string;
  description?: string;
}

/** A podcast episode to upload. */
export interface ZunePodcastEpisode {
  data: Uint8Array;
  filename: string;
  name: string;
  seriesHandle: number;
  seriesName?: string;
  url?: string;
  duration?: number;
  dateAuthored?: string;
  description?: string;
  format?: number;
}

/**
 * A connected Zune.
 *
 * Owns one MTP session, the MTPZ handshake and the storage selection, and
 * exposes the operations a sync engine needs: read the ZMDB library,
 * upload tracks with album/artist objects, create podcast series, delete
 * objects, write resume bookmarks and flush the device database.
 */
export class Zune {
  readonly protocol: MtpProtocol;
  private readonly transport: MtpTransport;
  private readonly options: ZuneOptions;
  private readonly auth: MtpzAuth;
  private _connected = false;
  private _deviceInfo: MtpDeviceInfo | null = null;
  private _storageInfo: MtpStorageInfo | null = null;
  private _storageId = 0;

  private constructor(transport: MtpTransport, options: ZuneOptions) {
    this.transport = transport;
    this.options = options;
    this.protocol = new MtpProtocol(transport, {
      chunkSize: options.chunkSize,
      zmdbSettleMs: options.zmdbSettleMs,
      responseTimeoutMs: options.responseTimeoutMs,
      logger: options.logger,
    });
    this.auth = new MtpzAuth(this.protocol);
  }

  /** Open a transport, start a session and authenticate. */
  static async open(options: ZuneOptions = {}): Promise<Zune> {
    let transport = options.transport;
    if (!transport) {
      const usb = new UsbTransport();
      await usb.open(options.productId);
      transport = usb;
    }
    const zune = new Zune(transport, options);
    await zune.connect();
    return zune;
  }

  /** Start the MTP session, run MTPZ auth and select a storage. */
  async connect(): Promise<void> {
    if (this._connected) return;

    await this.protocol.openSession(this.options.sessionId ?? 1);
    if (this.options.authenticate !== false) await this.auth.authenticate();

    this._deviceInfo = await this.protocol.getDeviceInfo();
    const storageIds = await this.protocol.getStorageIDs();
    this._storageId = this.options.storageId ?? storageIds[0] ?? 0;
    if (this._storageId) this._storageInfo = await this.protocol.getStorageInfo(this._storageId);

    this._connected = true;
  }

  /** True once {@link connect} has completed. */
  get connected(): boolean {
    return this._connected;
  }

  /** Facts reported by `GetDeviceInfo`. */
  get deviceInfo(): MtpDeviceInfo | null {
    return this._deviceInfo;
  }

  /** Facts reported by `GetStorageInfo`. */
  get storageInfo(): MtpStorageInfo | null {
    return this._storageInfo;
  }

  /** Selected storage ID. */
  get storageId(): number {
    return this._storageId;
  }

  /**
   * Recognised model, when a product ID was supplied.
   *
   * A product ID covers several capacities, so the storage capacity read
   * during {@link connect} is used to pick the exact model (a Zune 8 and a
   * Zune 30 share product ID `0x0710`).
   */
  get model(): ZuneModel | null {
    if (this.options.productId === undefined) return null;
    try {
      return detectDevice(
        this.options.productId,
        this._storageInfo?.maxCapacity ?? null
      );
    } catch {
      return null;
    }
  }

  /** ZMDB layout family used when parsing the library. */
  get family(): ZuneModelFamily {
    const model = this.model;
    if (model) return model.family;
    return this._deviceInfo?.model?.toUpperCase().includes('HD') ? 'hd' : 'classic';
  }

  /** Fetch and parse the device's ZMDB library. */
  async readDatabase(): Promise<ZmdbLibrary> {
    const payload = await this.protocol.readZMDB();
    return parseDatabase(payload, this.family);
  }

  /** List object handles for a format and parent. */
  async listObjects(formatCode = 0, parentHandle = 0): Promise<number[]> {
    return this.protocol.getObjectHandles(this._storageId, formatCode, parentHandle);
  }

  /**
   * Read a uint32 property from an object.
   *
   * Used to recover a track's duration when the ZMDB has none, which is also
   * what defeats a duration-based size check.
   */
  async getObjectPropUint32(handle: number, propCode: number): Promise<number> {
    return this.protocol.getObjectPropUint32(handle, propCode);
  }

  /** Read an object's string property (`GetObjectPropValue` as an MTP string). */
  async getObjectPropString(handle: number, propCode: number): Promise<string> {
    return this.protocol.getObjectPropString(handle, propCode);
  }

  /**
   * Read an album object's cover art.
   *
   * Artwork lives on the album object as `RepresentativeSampleData`, which is
   * where the sync writer puts it. Returns `undefined` when the object has no
   * sample or the device rejects the read.
   */
  async readAlbumArtwork(albumHandle: number): Promise<Uint8Array | undefined> {
    try {
      const data = await this.protocol.getObjectPropArray(
        albumHandle,
        ObjectProperty.RepresentativeSampleData,
      );
      return data.length > 0 ? data : undefined;
    } catch {
      return undefined;
    }
  }

  /** Create an artist object and return its handle. */
  async createArtist(name: string, options: ZuneUploadOptions = {}): Promise<number> {
    const handle = await this.createObject(
      ObjectFormat.Artist,
      buildArtistProps(name),
      options.parentHandle ?? 0,
      `${name}.art`,
      options.onWarning,
    );
    options.session?.track(handle);
    return handle;
  }

  /** Create an album object and return its handle. */
  async createAlbum(
    album: { name: string; albumArtist?: string; artistId?: number; dateAuthored?: string },
    options: ZuneUploadOptions = {},
  ): Promise<number> {
    const handle = await this.createObject(
      ObjectFormat.AbstractAudioAlbum,
      buildAlbumProps(album),
      options.parentHandle ?? 0,
      `${album.albumArtist ?? ""}--${album.name}.alb`,
      options.onWarning,
    );
    options.session?.track(handle);
    return handle;
  }

  /** Create a folder (association) object and return its handle. */
  async createFolder(name: string, parentHandle = 0, options: ZuneUploadOptions = {}): Promise<number> {
    const handle = await this.createObject(
      ObjectFormat.Association,
      [{ property: ObjectProperty.Name, type: DataType.STR, value: name }],
      parentHandle,
      name,
      options.onWarning,
    );
    options.session?.track(handle);
    return handle;
  }

  /** Create a podcast series (`.ser`) object and return its handle. */
  async createPodcastSeries(show: ZunePodcastSeries, options: ZuneUploadOptions = {}): Promise<number> {
    // Podcast objects are the one case the firmware accepts as a property
    // list, and the reference implementation creates them that way.
    const handle = await this.protocol.sendObjectPropList(
      this._storageId,
      options.parentHandle ?? 0,
      ObjectFormat.PodcastSeries,
      0,
      buildPodcastSeriesProps(show),
    );
    await this.protocol.sendObject(new Uint8Array(0));
    options.session?.track(handle);
    return handle;
  }

  /** Upload one track and return its object handle. */
  async uploadTrack(track: ZuneTrackUpload, options: ZuneUploadOptions = {}): Promise<number> {
    const format = track.format ?? formatForFilename(track.filename);
    const metadata: MtpObjectMetadata = {
      ...track.metadata,
      name: track.metadata?.name ?? stripExtension(track.filename),
    };

    if (options.registerTrackContext && metadata.albumName) {
      await this.protocol.registerTrackContext(metadata.albumName);
    }

    // Create the object with `SendObjectInfo` and set its properties one by
    // one afterwards. The Zune firmware accepts `SendObjectPropList` for
    // podcast objects but rejects it for music, so tracks take the same path
    // the reference implementation uses.
    const { objectHandle } = await this.protocol.sendObjectInfo(this._storageId, options.parentHandle ?? 0, {
      objectFormat: format,
      compressedSize: track.data.length,
      filename: track.filename,
    });
    await this.protocol.sendObject(track.data, options.onProgress ?? track.onProgress);
    // Track the handle before the properties: a rejected property must not
    // leave an object on the device that rollback cannot see.
    options.session?.track(objectHandle);
    await this.applyProps(objectHandle, buildTrackProps(metadata), options.onWarning);
    return objectHandle;
  }

  /**
   * Upload a batch of tracks, creating one artist and one album object per
   * album group first so the device files the tracks correctly.
   */
  async uploadTracks(tracks: ZuneTrackUpload[], options: ZuneUploadOptions = {}): Promise<number[]> {
    const groups = new Map<string, ZuneTrackUpload[]>();
    for (const track of tracks) {
      const key = `${track.metadata?.albumArtist ?? track.metadata?.artist ?? ''}\u0000${track.metadata?.albumName ?? ''}`;
      const group = groups.get(key);
      if (group) group.push(track);
      else groups.set(key, [track]);
    }

    const handles: number[] = [];
    for (const group of groups.values()) {
      const first = group[0].metadata ?? {};
      let artistId: number | undefined;
      let albumHandle: number | undefined;
      const albumName = first.albumName;

      if (albumName) {
        const artistName = first.albumArtist ?? first.artist;

        // Artist and album objects are containers the device files tracks
        // under. A Zune 8 answers `SendObjectInfo` for an Artist object with
        // 0x2016 InvalidCodeFormat, and the reference implementation creates
        // both inside a try/catch and carries on — so a rejected container
        // must not abort a transfer whose tracks the device does accept.
        if (artistName) {
          try {
            artistId = await this.createArtist(artistName, options);
          } catch (error) {
            options.onWarning?.(`artist "${artistName}"`, error);
          }
        }

        try {
          albumHandle = await this.createAlbum(
            { name: albumName, albumArtist: artistName, artistId, dateAuthored: first.dateAuthored },
            options,
          );
        } catch (error) {
          options.onWarning?.(`album "${albumName}"`, error);
        }
      }

      const groupHandles: number[] = [];
      for (const track of group) {
        const handle = await this.uploadTrack(
          { ...track, metadata: { ...track.metadata, artistId, albumName } },
          options,
        );
        groupHandles.push(handle);
        handles.push(handle);
        options.onTrackUploaded?.(handles.length, tracks.length);
      }

      // File the tracks under their album and give the album its cover art.
      // The device resolves a track's album and artist through these object
      // references, not through the track's own string properties, so without
      // them every synced track shows as "unknown album"/"unknown artist".
      // Artwork likewise lives on the album object (`RepresentativeSample*`),
      // which is where the reference implementation writes it.
      if (albumHandle !== undefined) {
        try {
          await this.protocol.setObjectReferences(albumHandle, groupHandles);
        } catch (error) {
          options.onWarning?.(`album "${albumName}" references`, error);
        }

        const art = first.albumArt;
        if (art) {
          try {
            // Order matters: the reference writes the sample data first, then
            // its size, then its format (`zune-manager.js:652-664`). Writing
            // the format first left the album with no thumbnail.
            await this.protocol.setObjectPropArray(
              albumHandle,
              ObjectProperty.RepresentativeSampleData,
              art.data,
            );
            await this.protocol.setObjectPropUint32(
              albumHandle,
              ObjectProperty.RepresentativeSampleSize,
              art.data.length,
            );
            await this.protocol.setObjectPropUint16(
              albumHandle,
              ObjectProperty.RepresentativeSampleFormat,
              art.format ?? ObjectFormat.JPEG,
            );
          } catch (error) {
            options.onWarning?.(`album "${albumName}" artwork`, error);
          }
        }
      }
    }

    return handles;
  }

  /** Upload one podcast episode under an existing series handle. */
  async uploadPodcastEpisode(
    episode: ZunePodcastEpisode,
    options: ZuneUploadOptions = {},
  ): Promise<number> {
    const format = episode.format ?? formatForFilename(episode.filename);
    const handle = await this.protocol.sendObjectPropList(
      this._storageId,
      options.parentHandle ?? 0,
      format,
      episode.data.length,
      buildEpisodeProps(episode),
    );
    await this.protocol.sendObject(episode.data, options.onProgress);
    options.session?.track(handle);
    return handle;
  }

  /** Delete an object by handle. */
  async deleteObject(handle: number): Promise<void> {
    await this.protocol.deleteObject(handle);
  }

  /** Write a resume position (milliseconds) for an episode. */
  async setBookmark(handle: number, positionMs: number): Promise<void> {
    await this.protocol.setObjectPropUint32(handle, ObjectProperty.TimeBookmark, Math.max(0, Math.round(positionMs)));
  }

  /** Flush pending writes to the device database (`0x9217`). */
  async syncDeviceDB(param = 1): Promise<void> {
    await this.protocol.syncDeviceDB(param);
  }

  /** Create a transactional upload session bound to this device. */
  createSession(): ZuneSync {
    return new ZuneSync(this);
  }

  /** End the trusted session, close MTP and release the transport. */
  async eject(): Promise<void> {
    try {
      await this.protocol.disableTrustedFiles();
    } catch {
      // The device may already have ended the trusted session.
    }
    await this.disconnect();
  }

  /**
   * Read one object's `ObjectInfo` dataset by handle.
   *
   * This is direct evidence an object exists on the device, independent of
   * the ZMDB, which the device rebuilds on its own schedule. It also reports
   * the size the device actually stored.
   */
  async getObjectInfo(handle: number): Promise<{
    objectFormat: number;
    compressedSize: number;
    parentObject: number;
    filename: string;
  }> {
    if (!this._connected) throw new ZuneError('NOT_CONNECTED', 'Zune is not connected');
    return await this.protocol.getObjectInfo(handle);
  }

  /** Close the MTP session and release the transport. */
  async disconnect(): Promise<void> {    if (!this._connected) return;
    try {
      await this.protocol.closeSession();
    } catch {
      // Closing a session that the device already dropped is not an error.
    }
    await this.transport.close?.();
    this._connected = false;
  }

  private async createObject(
    format: number,
    props: MtpPropValue[],
    parentHandle: number,
    filename: string,
    onWarning?: (what: string, error: unknown) => void,
  ): Promise<number> {
    if (!this._connected) throw new ZuneError('NOT_CONNECTED', 'Zune is not connected');
    const { objectHandle } = await this.protocol.sendObjectInfo(this._storageId, parentHandle, {
      objectFormat: format,
      compressedSize: 0,
      filename,
    });
    await this.protocol.sendObject(new Uint8Array(0));
    await this.applyProps(objectHandle, props, onWarning);
    return objectHandle;
  }

  /**
   * Write each property of a created object with `SetObjectPropValue`.
   *
   * Every property is attempted on its own: a Zune 8 rejects some of them
   * (`0xa801` on an album's `Name`, for instance) while accepting the object,
   * and the reference implementation sets each inside its own try/catch
   * (`zune-manager.js:601-620`). Aborting on the first rejection threw away the
   * whole object — the handle was never returned, never tracked for rollback,
   * and the track that followed lost its album link.
   *
   * With an `onWarning` handler a rejected property is reported and skipped;
   * without one it still throws, so a caller that wants strictness keeps it.
   */
  private async applyProps(
    handle: number,
    props: MtpPropValue[],
    onWarning?: (what: string, error: unknown) => void,
  ): Promise<void> {
    for (const prop of props) {
      if (prop.value === undefined || prop.value === '') continue;

      try {
        switch (prop.type) {
          case DataType.STR:
            await this.protocol.setObjectPropString(handle, prop.property, String(prop.value));
            break;          case DataType.UINT8:
            await this.protocol.setObjectPropUint16(handle, prop.property, Number(prop.value) & 0xff);
            break;
          case DataType.UINT16:
            await this.protocol.setObjectPropUint16(handle, prop.property, Number(prop.value) & 0xffff);
            break;
          case DataType.UINT32:
            await this.protocol.setObjectPropUint32(handle, prop.property, Number(prop.value) >>> 0);
            break;
          case DataType.AUINT16:
            await this.protocol.setObjectPropAuint16(handle, prop.property, String(prop.value));
            break;
          case DataType.AUINT8:
            await this.protocol.setObjectPropArray(handle, prop.property, prop.value as Uint8Array);
            break;
          default:
            throw new ZuneError(
              'UNSUPPORTED_FORMAT',
              `Unsupported property data type 0x${prop.type.toString(16)}`,
            );
        }
      } catch (error) {
        // A device rejection (`MTP_RESPONSE`) costs only that property; a
        // programming error such as an unsupported data type still throws.
        const rejected =
          error instanceof ZuneError && error.code === 'MTP_RESPONSE';
        if (!rejected) throw error;
        onWarning?.(`property 0x${prop.property.toString(16)}`, error);
      }
    }
  }}

/** Map a filename extension to an MTP object format, defaulting to MP3. */
export function formatForFilename(filename: string): number {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return ObjectFormat.MP3;
  return ExtensionToFormat[filename.slice(dot).toLowerCase()] ?? ObjectFormat.MP3;
}

/** Strip the final extension from a filename. */
export function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}
