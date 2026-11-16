import { Schema } from '../constants/index.js';
import { PodcastField, VarintField } from '../constants/index.js';
import { parseBackwardsVarints } from '../varint/index.js';
import type {
  ZmdbAlbum,
  ZmdbArtist,
  ZmdbPicture,
  ZmdbPlaylist,
  ZmdbPodcastEpisode,
  ZmdbPodcastShow,
  ZmdbTrack,
  ZmdbVideo,
} from '../types.js';
import { filetimeToISOString, readNullTerminatedUtf8, utf16leToString } from '../../common/util/index.js';
import { utf8FromBytes } from '../../common/binary/reader.js';
import { utf8ToBytes } from '../../common/binary/writer.js';

/** Reference resolution the record parsers borrow from the database container. */
export interface ZmdbRecordContext {
  isHD: boolean;
  entrySize(schema: number): number;
  resolveString(atomId: number): string;
  resolveArtist(atomId: number): ZmdbArtist | null;
  resolveAlbum(atomId: number): ZmdbAlbum | null;
  resolveGenre(atomId: number): string;
}

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

function readInt32(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) return 0;
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
}

function readUint64(bytes: Uint8Array, offset: number): bigint {
  if (offset + 8 > bytes.length) return 0n;
  return BigInt(readUint32(bytes, offset)) | (BigInt(readUint32(bytes, offset + 4)) << 32n);
}

/** Decode a UTF-16LE varint payload, trimming the optional pad and NUL terminator. */
function utf16Payload(data: Uint8Array): string {
  let start = 0;
  let end = data.length;
  if (data[0] === 0x00 && data[end - 1] === 0x00) {
    start = 1;
    end -= 1;
  }
  return utf16leToString(data, start, end);
}

/** Find the UTF-16LE filename (field `0x44`) in a record's varint tail. */
function varintFilename(record: Uint8Array, entrySize: number): string {
  for (const field of parseBackwardsVarints(record, entrySize)) {
    if (field.fieldId === VarintField.Filename && field.fieldSize > 2) {
      return utf16Payload(field.data);
    }
  }
  return '';
}

/** Parse a music track (schema `0x01`). */
export function parseTrackRecord(record: Uint8Array, atomId: number, ctx: ZmdbRecordContext): ZmdbTrack | null {
  const titleOffset = ctx.entrySize(Schema.Music);
  if (record.length < titleOffset) return null;

  const albumRef = readUint32(record, 0);
  const artistRef = readUint32(record, 4);
  const genreRef = readUint32(record, 8);
  const filenameRef = readUint32(record, 12);

  const track: ZmdbTrack = {
    atomId,
    title: record.length > titleOffset ? readNullTerminatedUtf8(record, titleOffset) : '',    artist: '',
    album: '',
    albumArtist: '',
    genre: '',
    trackNumber: readUint16(record, 24),
    discNumber: 1,
    duration: readInt32(record, 16),
    size: readInt32(record, 20),
    playcount: readUint16(record, 26),
    // A classic track head is 28 bytes, so offsets 28 and 30 are the first
    // characters of the title, not fields. Reading them unconditionally made
    // "Higher" report codec 26952 and rating 103.
    codecId: titleOffset >= 30 ? readUint16(record, 28) : 0,
    rating: titleOffset > 30 ? record[30] : 0,
    filename: '',
    albumRef,
    genreRef,
  };

  for (const field of parseBackwardsVarints(record, titleOffset)) {
    if (field.fieldId === VarintField.DiscNumber && field.fieldSize >= 1 && field.fieldSize <= 4) {
      track.discNumber = readUint32(field.data, 0) || 1;
    }
  }

  if (albumRef) {
    const album = ctx.resolveAlbum(albumRef);
    if (album) {
      track.album = album.title;
      track.albumArtist = album.artistName;
    }
  }
  if (artistRef) {
    const artist = ctx.resolveArtist(artistRef);
    if (artist) track.artist = artist.name;
  }
  if (genreRef) track.genre = ctx.resolveGenre(genreRef);
  if (filenameRef) {
    const resolved = ctx.resolveString(filenameRef);
    track.filename = resolved;
    if (!track.title) track.title = resolved;
  }

  return track;
}

/** Parse a video (schema `0x02`). */
export function parseVideoRecord(record: Uint8Array, atomId: number, ctx: ZmdbRecordContext): ZmdbVideo | null {
  if (record.length < 16) return null;

  const folderRef = readUint32(record, 0);
  const titleRef = readUint32(record, 4);

  return {
    atomId,
    title: titleRef ? ctx.resolveString(titleRef) : '',
    folder: folderRef ? ctx.resolveString(folderRef) : '',
    size: record.length >= 40 ? readUint32(record, 32) : 0,
    codecId: record.length >= 40 ? readUint32(record, 36) : 0,
    filename: varintFilename(record, ctx.entrySize(Schema.Video)),
  };
}

/** Parse a picture (schema `0x03`). */
export function parsePictureRecord(record: Uint8Array, atomId: number, ctx: ZmdbRecordContext): ZmdbPicture | null {
  if (record.length < 24) return null;

  const folderRef = readUint32(record, 0);
  const albumRef = readUint32(record, 4);
  const collectionRef = readUint32(record, 8);
  const fileRef = readUint32(record, 12);

  return {
    atomId,
    title: record.length > 24 ? readNullTerminatedUtf8(record, 24) : '',
    photoAlbum: albumRef ? ctx.resolveString(albumRef) : '',
    folder: folderRef ? ctx.resolveString(folderRef) : '',
    collection: collectionRef ? ctx.resolveString(collectionRef) : '',
    filename: fileRef ? ctx.resolveString(fileRef) : '',
  };
}

/** Parse a playlist (schema `0x07`) and its ordered track references. */
export function parsePlaylistRecord(
  record: Uint8Array,
  atomId: number,
  ctx: ZmdbRecordContext,
): ZmdbPlaylist | null {
  if (record.length < 12) return null;

  const folderRef = readUint32(record, 8);
  const playlist: ZmdbPlaylist = {
    atomId,
    name: '',
    folder: folderRef ? ctx.resolveString(folderRef) : '',
    filename: '',
    trackCount: readUint32(record, 0),
    trackAtomIds: [],
  };

  if (record.length <= 12) return playlist;

  let nullPos = 12;
  while (nullPos < record.length && record[nullPos] !== 0) nullPos++;
  if (nullPos > 12) playlist.name = utf8FromBytes(record.subarray(12, nullPos));

  if (nullPos + 3 >= record.length) return playlist;

  let pos = nullPos + 1;
  const hasGuid = record[pos + 1] !== 0x00;

  if (hasGuid && pos + 18 < record.length) {
    pos += 16;
    pos += 2;
  }

  const utf16Start = pos;
  while (pos + 1 < record.length) {
    if (record[pos] === 0 && record[pos + 1] === 0) break;
    pos += 2;
  }
  if (pos > utf16Start) playlist.filename = utf16leToString(record, utf16Start, pos);

  pos += 4;

  while (pos + 4 <= record.length) {
    const trackId = readUint32(record, pos);
    if (trackId === 0) break;
    if (((trackId >> 24) & 0xff) === Schema.Music) playlist.trackAtomIds.push(trackId);
    pos += 4;
  }

  return playlist;
}

/**
 * Parse a podcast show (schema `0x0f`). Layout is identical on HD and
 * Classic: folder ref at `+0x00`, subscribed flag at `+0x05`, UTF-8 name
 * at `+0x08`, then the varint tail.
 */
export function parsePodcastShowRecord(
  record: Uint8Array,
  atomId: number,
  _ctx: ZmdbRecordContext,
): ZmdbPodcastShow | null {
  if (record.length < 9) return null;

  const name = readNullTerminatedUtf8(record, 8);
  const show: ZmdbPodcastShow = {
    atomId,
    name,
    folderRef: readUint32(record, 0),
    subscribed: record[5] !== 0,
    serFilename: '',
    author: '',
    feedUrl: '',
  };

  const varStart = 8 + utf8ToBytes(name).length + 1;
  for (const field of parseBackwardsVarints(record, varStart)) {
    if (field.fieldId === PodcastField.Filename) show.serFilename = utf16Payload(field.data);
    else if (field.fieldId === PodcastField.Author) show.author = utf16Payload(field.data);
    else if (field.fieldId === PodcastField.Url) show.feedUrl = utf16Payload(field.data);
  }

  return show;
}

/**
 * Parse a podcast episode (schema `0x10`).
 *
 * HD: size at `+0x18`, codec at `+0x1e`, played flags at `+0x20`, title at `+0x24`.
 * Classic: codec at `+0x1a`, played flags at `+0x1c`, title at `+0x20` (no size).
 */
export function parsePodcastEpisodeRecord(
  record: Uint8Array,
  atomId: number,
  ctx: ZmdbRecordContext,
): ZmdbPodcastEpisode | null {
  const titleOffset = ctx.isHD ? 0x24 : 0x20;
  if (record.length < titleOffset) return null;

  const title = readNullTerminatedUtf8(record, titleOffset);
  const episode: ZmdbPodcastEpisode = {
    atomId,
    title,
    folderRef: readUint32(record, 0x00),
    showAtomId: readUint32(record, 0x04),
    duration: readUint32(record, 0x08),
    bookmarkMs: readUint32(record, 0x0c),
    releaseDate: filetimeToISOString(readUint64(record, 0x10)),
    size: ctx.isHD ? readUint32(record, 0x18) : 0,
    codecId: readUint16(record, ctx.isHD ? 0x1e : 0x1a),
    playedFlags: readUint32(record, ctx.isHD ? 0x20 : 0x1c),
    url: '',
    author: '',
    description: '',
    showName: '',
    showFeedUrl: '',
  };

  const varStart = titleOffset + utf8ToBytes(title).length + 1;
  for (const field of parseBackwardsVarints(record, varStart)) {
    if (field.fieldId === PodcastField.Url) episode.url = utf16Payload(field.data);
    else if (field.fieldId === PodcastField.Author) episode.author = utf16Payload(field.data);
    else if (field.fieldId === PodcastField.Description) episode.description = utf16Payload(field.data);
  }

  return episode;
}
