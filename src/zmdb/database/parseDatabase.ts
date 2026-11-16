import { ZMDB } from './ZMDB.js';
import type { ZmdbDeviceFamily, ZmdbLibrary } from '../types.js';

/**
 * Parse a ZMDB buffer into a typed library.
 *
 * @param data - The raw `ZMDB` file contents.
 * @param deviceFamily - Layout hint; the `ZMed` version in the file wins.
 * @returns Tracks, albums, artists, genres, videos, pictures, playlists and podcasts.
 * @throws {ZuneError} `NOT_A_ZMDB`, `MISSING_ZMED` or `MISSING_ZARR` when the
 *   buffer is not a Zune media database.
 */
export function parseDatabase(
  data: ArrayBuffer | Uint8Array,
  deviceFamily: ZmdbDeviceFamily = 'hd',
): ZmdbLibrary {
  return new ZMDB(data, deviceFamily).parse();
}
