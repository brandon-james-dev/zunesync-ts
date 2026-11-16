import { ZuneError } from '../../common/errors/index.js';
import { filetimeToDate, readNullTerminatedUtf8, utf16leToString } from '../../common/util/index.js';
import {
  DESCRIPTOR_COUNT,
  DESCRIPTOR_SIZE,
  ENTRY_SIZES_CLASSIC,
  ENTRY_SIZES_HD,
  HD_DESCRIPTOR_MAP,
  CLASSIC_DESCRIPTOR_MAP,
  INDEX_ENTRY_SIZE,
  Schema,
  ZARR_MAGIC,
  ZMED_MAGIC,
  ZMED_OFFSET,
  ZMDB_MAGIC,
} from '../constants/index.js';
import { parseBackwardsVarints } from '../varint/index.js';
import type {
  ZmdbAlbum,
  ZmdbArtist,
  ZmdbDescriptor,
  ZmdbDeviceFamily,
  ZmdbGenre,
  ZmdbHeader,
  ZmdbLibrary,
  ZmdbVarintField,
} from '../types.js';
import type { ZmdbRecordContext } from './records.js';
import {
  parsePictureRecord,
  parsePlaylistRecord,
  parsePodcastEpisodeRecord,
  parsePodcastShowRecord,
  parseTrackRecord,
  parseVideoRecord,
} from './records.js';

function readUint16(bytes: Uint8Array, offset: number): number {
  if (offset + 2 > bytes.length) return 0;
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) return 0;
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
  );
}

function readUint64(bytes: Uint8Array, offset: number): bigint {
  if (offset + 8 > bytes.length) return 0n;
  return BigInt(readUint32(bytes, offset)) | (BigInt(readUint32(bytes, offset + 4)) << 32n);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = '';
  for (let i = start; i < end && i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/**
 * ZMDB (Zune Media Database) reader.
 *
 * Parses the Zune's internal binary database in a single pass: a `ZMDB`
 * magic, a `ZMed` header carrying the layout version, a `ZArr` block of
 * 96 descriptors, an index table mapping atom IDs to record offsets, and
 * the records themselves.
 *
 * Two layouts exist:
 *   `ZMed` version 2 — Classic (Zune 30/80/120, flash 4/8/16)
 *   `ZMed` version 5 — Zune HD
 *
 * The `ZMed` version overrides the caller's `deviceFamily` hint, so a
 * database always parses with the layout it was written with.
 */
export class ZMDB {
  private readonly bytes: Uint8Array;
  private family: ZmdbDeviceFamily;
  private entrySizes: Record<number, number>;
  private descriptors: ZmdbDescriptor[] = [];
  private indexTable = new Map<number, number>();
  private zarrOffset = 0;
  private zmedVersion = 0;
  private readonly recordCache = new Map<number, Uint8Array>();
  private readonly stringCache = new Map<number, string>();
  private readonly artistCache = new Map<number, ZmdbArtist>();
  private readonly albumCache = new Map<number, ZmdbAlbum>();
  private readonly genreCache = new Map<number, ZmdbGenre>();

  constructor(data: ArrayBuffer | Uint8Array, deviceFamily: ZmdbDeviceFamily = 'hd') {
    this.bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.family = deviceFamily;
    this.entrySizes = deviceFamily === 'hd' ? ENTRY_SIZES_HD : ENTRY_SIZES_CLASSIC;
  }

  /** Header facts recovered by the last {@link parse} call. */
  get header(): ZmdbHeader {
    return {
      zmedVersion: this.zmedVersion,
      deviceFamily: this.family,
      zarrOffset: this.zarrOffset,
      descriptorCount: this.descriptors.length,
      indexEntryCount: this.indexTable.size,
    };
  }

  /** Layout family actually used, after the `ZMed` version override. */
  get deviceFamily(): ZmdbDeviceFamily {
    return this.family;
  }

  /** The 96 parsed descriptors, in file order. */
  getDescriptors(): ZmdbDescriptor[] {
    return this.descriptors;
  }

  /** Atom ID to absolute record offset. */
  getIndexTable(): Map<number, number> {
    return this.indexTable;
  }

  /** Read one record, honouring its 24-bit size header. */
  getRecord(offset: number): Uint8Array | null {
    const cached = this.recordCache.get(offset);
    if (cached) return cached;
    if (offset < 4 || offset >= this.bytes.length) return null;

    const headerValue = readUint32(this.bytes, offset - 4);
    if (headerValue & 0x80000000) return null;

    const recordSize = headerValue & 0x00ffffff;
    if (offset + recordSize > this.bytes.length) return null;

    const record = this.bytes.slice(offset, offset + recordSize);
    this.recordCache.set(offset, record);
    return record;
  }

  /** Parse the backwards-varint tail of the record at `offset`. */
  getVarints(offset: number): ZmdbVarintField[] {
    const record = this.getRecord(offset);
    if (!record) return [];
    return parseBackwardsVarints(record, this.entrySize(this.schemaOf(offset)));
  }

  /** Resolve a string atom (filename, genre, title, collection). */
  resolveString(atomId: number): string {
    if (!atomId) return '';
    const cached = this.stringCache.get(atomId);
    if (cached !== undefined) return cached;

    const offset = this.indexTable.get(atomId);
    if (offset === undefined) return '';
    const record = this.getRecord(offset);
    if (!record) return '';

    let result = '';
    switch ((atomId >> 24) & 0xff) {
      case Schema.Filename:
        if (record.length > 8) result = readNullTerminatedUtf8(record, 8);
        break;
      case Schema.Genre:
        if (record.length > 1) result = readNullTerminatedUtf8(record, 1);
        break;
      case Schema.VideoTitle:
        if (record.length > 4) result = readNullTerminatedUtf8(record, 4);
        break;
      case Schema.PhotoAlbum:
      case Schema.Collection:
        if (record.length >= 20) result = readNullTerminatedUtf8(record, 12);
        break;
      case Schema.PodcastShow:
      case Schema.AudiobookTitle:
        if (record.length > 8) result = readNullTerminatedUtf8(record, 8);
        break;
      case Schema.Album:
      case Schema.Artist: {
        const entrySize = this.entrySizes[Schema.Album] ?? 0;
        if (entrySize) {
          for (const field of parseBackwardsVarints(record, entrySize)) {
            if (field.fieldId === 0x44 && field.fieldSize > 2) {
              let start = 0;
              let end = field.data.length;
              if (field.data[0] === 0x00 && field.data[end - 1] === 0x00) {
                start = 1;
                end -= 1;
              }
              result = utf16leToString(field.data, start, end);
              break;
            }
          }
        }
        break;
      }
    }

    this.stringCache.set(atomId, result);
    return result;
  }

  /** Resolve an artist atom, including its `.art` filename and GUID. */
  resolveArtist(atomId: number): ZmdbArtist | null {
    if (!atomId) return null;
    const cached = this.artistCache.get(atomId);
    if (cached) return cached;

    const offset = this.indexTable.get(atomId);
    if (offset === undefined) return null;
    const record = this.getRecord(offset);
    if (!record) return null;

    const artist: ZmdbArtist = { atomId, name: '', filename: '', guid: '' };
    const entrySize = this.entrySizes[Schema.Artist];

    if (record.length > entrySize) artist.name = readNullTerminatedUtf8(record, entrySize);

    for (const field of parseBackwardsVarints(record, entrySize)) {
      if (field.fieldId === 0x44 && field.fieldSize > 2) {
        let start = 0;
        let end = field.data.length;
        if (field.data[0] === 0x00 && field.data[end - 1] === 0x00) {
          start = 1;
          end -= 1;
        }
        artist.filename = utf16leToString(field.data, start, end);
        if (!artist.name) artist.name = artist.filename.replace(/\.art$/i, '');
      } else if (field.fieldId === 0x14 && field.fieldSize === 16) {
        artist.guid = formatGuid(field.data);
      }
    }

    this.artistCache.set(atomId, artist);
    return artist;
  }

  /** Resolve an album atom, including its release year and `.alb` filename. */
  resolveAlbum(atomId: number): ZmdbAlbum | null {
    if (!atomId) return null;
    const cached = this.albumCache.get(atomId);
    if (cached) return cached;

    const offset = this.indexTable.get(atomId);
    if (offset === undefined) return null;
    const record = this.getRecord(offset);
    if (!record || record.length < 20) return null;

    const album: ZmdbAlbum = {
      atomId,
      artistRef: readUint32(record, 0),
      title: '',
      artistName: '',
      releaseYear: 0,
      filename: '',
    };

    let titleOffset = this.entrySizes[Schema.Album];
    let hasFiletime = this.family === 'hd';
    if (this.family === 'classic' && record.length > 20) {
      const firstByte = record[titleOffset];
      if (firstByte > 127 || (firstByte === 0 && record[titleOffset + 1] !== 0)) {
        hasFiletime = true;
        titleOffset = 20;
      }
    }

    // Only read the FILETIME when the record actually has one. A classic album
    // record is 12 bytes of head followed by the title, so reading a uint64 at
    // offset 12 decoded the title's first characters as a timestamp — which is
    // where years like 24753 and 19897 came from.
    if (hasFiletime) {
      const filetime = readUint64(record, 12);
      const released = filetimeToDate(filetime);
      if (released) album.releaseYear = released.getUTCFullYear();
    }

    if (record.length > titleOffset) album.title = readNullTerminatedUtf8(record, titleOffset);

    if (album.artistRef) {
      const artist = this.resolveArtist(album.artistRef);
      if (artist) album.artistName = artist.name;
    }

    const entrySize = hasFiletime ? 20 : (this.entrySizes[Schema.Album] ?? 20);
    for (const field of parseBackwardsVarints(record, entrySize)) {
      if (field.fieldId === 0x44 && field.fieldSize > 2) {
        let start = 0;
        let end = field.data.length;
        if (field.data[0] === 0x00 && field.data[end - 1] === 0x00) {
          start = 1;
          end -= 1;
        }
        album.filename = utf16leToString(field.data, start, end);
        if (!album.title) {
          let name = album.filename.replace(/\.alb$/i, '');
          const separator = name.indexOf('--');
          if (separator !== -1) name = name.substring(separator + 2);
          album.title = name;
        }
        break;
      }
    }

    this.albumCache.set(atomId, album);
    return album;
  }

  /** Resolve a genre atom to its display name. */
  resolveGenre(atomId: number): string {
    if (!atomId) return '';
    const cached = this.genreCache.get(atomId);
    if (cached) return cached.name;

    const name = this.resolveString(atomId);
    if (name) this.genreCache.set(atomId, { atomId, name });
    return name;
  }

  /** Parse the whole database. */
  parse(): ZmdbLibrary {
    const library: ZmdbLibrary = {
      tracks: [],
      albums: {},
      artists: {},
      genres: {},
      videos: [],
      pictures: [],
      playlists: [],
      podcastShows: [],
      podcastEpisodes: [],
    };

    if (this.bytes.length < 0x30) return library;
    if (ascii(this.bytes, 0, 4) !== ZMDB_MAGIC) {
      throw new ZuneError('NOT_A_ZMDB', 'Not a ZMDB file (bad magic)');
    }
    if (ascii(this.bytes, ZMED_OFFSET, ZMED_OFFSET + 4) !== ZMED_MAGIC) {
      throw new ZuneError('MISSING_ZMED', 'Missing ZMed header');
    }

    this.zmedVersion = readUint16(this.bytes, ZMED_OFFSET + 4);
    if (this.zmedVersion >= 5 && this.family !== 'hd') {
      this.family = 'hd';
      this.entrySizes = ENTRY_SIZES_HD;
    } else if (this.zmedVersion > 0 && this.zmedVersion < 5 && this.family !== 'classic') {
      this.family = 'classic';
      this.entrySizes = ENTRY_SIZES_CLASSIC;
    }

    this.zarrOffset = 0;
    for (let offset = 0x30; offset < 0x100 && offset + 4 <= this.bytes.length; offset += 4) {
      if (ascii(this.bytes, offset, offset + 4) === ZARR_MAGIC) {
        this.zarrOffset = offset;
        break;
      }
    }
    if (!this.zarrOffset) {
      throw new ZuneError('MISSING_ZARR', 'ZArr descriptor block not found');
    }

    this.descriptors = [];
    for (let i = 0; i < DESCRIPTOR_COUNT; i++) {
      const offset = this.zarrOffset + i * DESCRIPTOR_SIZE;
      if (offset + DESCRIPTOR_SIZE > this.bytes.length) break;
      this.descriptors.push({
        entrySize: readUint16(this.bytes, offset + 6),
        entryCount: readUint32(this.bytes, offset + 8),
        dataOffset: readUint32(this.bytes, offset + 16),
      });
    }

    const index = this.descriptors[0];
    if (index && index.entryCount > 0 && index.entrySize === INDEX_ENTRY_SIZE) {
      for (let i = 0; i < index.entryCount; i++) {
        const offset = index.dataOffset + i * INDEX_ENTRY_SIZE;
        if (offset + INDEX_ENTRY_SIZE > this.bytes.length) break;
        this.indexTable.set(readUint32(this.bytes, offset), readUint32(this.bytes, offset + 4));
      }
    }

    const descriptorMap = this.family === 'hd' ? HD_DESCRIPTOR_MAP : CLASSIC_DESCRIPTOR_MAP;
    const seen = new Set<number>();

    for (const descriptorIndex of Object.keys(descriptorMap).map(Number)) {
      const descriptor = this.descriptors[descriptorIndex];
      if (!descriptor || !descriptor.entryCount) continue;

      for (let i = 0; i < descriptor.entryCount; i++) {
        const offset = descriptor.dataOffset + i * descriptor.entrySize;
        if (offset + 4 > this.bytes.length) break;

        const atomId = readUint32(this.bytes, offset);
        const recordOffset = this.indexTable.get(atomId);
        if (recordOffset === undefined || seen.has(recordOffset)) continue;
        seen.add(recordOffset);

        const record = this.getRecord(recordOffset);
        if (!record) continue;
        if (record.length >= 12) {
          const ref0 = readUint32(record, 0);
          const ref1 = readUint32(record, 4);
          const ref2 = readUint32(record, 8);
          if (ref0 === 0 && ref1 === 0 && ref2 === 0) continue;
        }

        switch ((atomId >> 24) & 0xff) {
          case Schema.Music: {
            const track = parseTrackRecord(record, atomId, this.context());
            if (track) library.tracks.push(track);
            break;
          }
          case Schema.Video: {
            const video = parseVideoRecord(record, atomId, this.context());
            if (video) library.videos.push(video);
            break;
          }
          case Schema.Picture: {
            const picture = parsePictureRecord(record, atomId, this.context());
            if (picture) library.pictures.push(picture);
            break;
          }
          case Schema.Playlist: {
            const playlist = parsePlaylistRecord(record, atomId, this.context());
            if (playlist) library.playlists.push(playlist);
            break;
          }
        }
      }
    }

    library.albums = Object.fromEntries(this.albumCache);
    library.artists = Object.fromEntries(this.artistCache);
    library.genres = Object.fromEntries(this.genreCache);

    this.extractPodcasts(library);
    return library;
  }

  private extractPodcasts(library: ZmdbLibrary): void {
    for (const [atomId, offset] of this.indexTable) {
      const schema = (atomId >> 24) & 0xff;
      if (schema !== Schema.PodcastShow && schema !== Schema.PodcastEpisode) continue;

      const record = this.getRecord(offset);
      if (!record) continue;

      if (schema === Schema.PodcastShow) {
        const show = parsePodcastShowRecord(record, atomId, this.context());
        if (show) library.podcastShows.push(show);
      } else {
        const episode = parsePodcastEpisodeRecord(record, atomId, this.context());
        if (episode) library.podcastEpisodes.push(episode);
      }
    }

    const shows = new Map(library.podcastShows.map((show) => [show.atomId, show]));
    for (const episode of library.podcastEpisodes) {
      const show = shows.get(episode.showAtomId);
      episode.showName = show ? show.name : '';
      episode.showFeedUrl = show ? show.feedUrl : '';
    }
  }

  private context(): ZmdbRecordContext {
    return {
      isHD: this.family === 'hd',
      entrySize: (schema) => this.entrySizes[schema] ?? 0,
      resolveString: (atomId) => this.resolveString(atomId),
      resolveArtist: (atomId) => this.resolveArtist(atomId),
      resolveAlbum: (atomId) => this.resolveAlbum(atomId),
      resolveGenre: (atomId) => this.resolveGenre(atomId),
    };
  }

  private entrySize(schema: number): number {
    return this.entrySizes[schema] ?? 0;
  }

  private schemaOf(offset: number): number {
    for (const [atomId, recordOffset] of this.indexTable) {
      if (recordOffset === offset) return (atomId >> 24) & 0xff;
    }
    return 0;
  }
}

function formatGuid(data: Uint8Array): string {
  const hex = (byte: number): string => byte.toString(16).padStart(2, '0');
  return (
    `{${hex(data[3])}${hex(data[2])}${hex(data[1])}${hex(data[0])}-` +
    `${hex(data[5])}${hex(data[4])}-${hex(data[7])}${hex(data[6])}-` +
    `${hex(data[8])}${hex(data[9])}-` +
    `${hex(data[10])}${hex(data[11])}${hex(data[12])}${hex(data[13])}${hex(data[14])}${hex(data[15])}}`
  );
}
