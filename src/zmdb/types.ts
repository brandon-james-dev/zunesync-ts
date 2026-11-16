/** Device family, which selects the record layouts used by the parser. */
export type ZmdbDeviceFamily = 'hd' | 'classic';

/** One backwards-varint field carved out of a record's tail. */
export interface ZmdbVarintField {
  /** Field identifier (for example `0x44` for a UTF-16 filename). */
  fieldId: number;
  /** Declared payload length in bytes. */
  fieldSize: number;
  /** Payload bytes. */
  data: Uint8Array;
}

/** One 20-byte `ZArr` descriptor. */
export interface ZmdbDescriptor {
  /** Fixed record size for this descriptor's entries. */
  entrySize: number;
  /** Number of entries. */
  entryCount: number;
  /** Absolute file offset of the entry array. */
  dataOffset: number;
}

/** A music track (schema `0x01`). */
export interface ZmdbTrack {
  atomId: number;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  genre: string;
  trackNumber: number;
  discNumber: number;
  /** Duration in milliseconds. */
  duration: number;
  /** File size in bytes. */
  size: number;
  playcount: number;
  codecId: number;
  rating: number;
  filename: string;
  albumRef: number;
  genreRef: number;
}

/** An album (schema `0x06`). */
export interface ZmdbAlbum {
  atomId: number;
  artistRef: number;
  title: string;
  artistName: string;
  releaseYear: number;
  filename: string;
}

/** An artist (schema `0x08`). */
export interface ZmdbArtist {
  atomId: number;
  name: string;
  filename: string;
  guid: string;
}

/** A genre (schema `0x09`). */
export interface ZmdbGenre {
  atomId: number;
  name: string;
}

/** A video (schema `0x02`). */
export interface ZmdbVideo {
  atomId: number;
  title: string;
  folder: string;
  size: number;
  codecId: number;
  filename: string;
}

/** A picture (schema `0x03`). */
export interface ZmdbPicture {
  atomId: number;
  title: string;
  photoAlbum: string;
  folder: string;
  collection: string;
  filename: string;
}

/** A playlist (schema `0x07`). */
export interface ZmdbPlaylist {
  atomId: number;
  name: string;
  folder: string;
  filename: string;
  trackCount: number;
  trackAtomIds: number[];
}

/** A podcast show (schema `0x0f`). */
export interface ZmdbPodcastShow {
  atomId: number;
  name: string;
  folderRef: number;
  subscribed: boolean;
  serFilename: string;
  author: string;
  feedUrl: string;
}

/** A podcast episode (schema `0x10`). */
export interface ZmdbPodcastEpisode {
  atomId: number;
  title: string;
  folderRef: number;
  showAtomId: number;
  /** Duration in milliseconds. */
  duration: number;
  /** Resume position in milliseconds. */
  bookmarkMs: number;
  releaseDate: string | null;
  size: number;
  codecId: number;
  playedFlags: number;
  url: string;
  author: string;
  description: string;
  showName: string;
  showFeedUrl: string;
}

/** Everything a single ZMDB pass extracts. */
export interface ZmdbLibrary {
  tracks: ZmdbTrack[];
  /** Albums keyed by atom ID. */
  albums: Record<number, ZmdbAlbum>;
  /** Artists keyed by atom ID. */
  artists: Record<number, ZmdbArtist>;
  /** Genres keyed by atom ID. */
  genres: Record<number, ZmdbGenre>;
  videos: ZmdbVideo[];
  pictures: ZmdbPicture[];
  playlists: ZmdbPlaylist[];
  podcastShows: ZmdbPodcastShow[];
  podcastEpisodes: ZmdbPodcastEpisode[];
}

/** Header facts recovered while parsing. */
export interface ZmdbHeader {
  /** `ZMed` format version (2 for classic, 5 for Zune HD). */
  zmedVersion: number;
  /** Layout family actually used, after the `ZMed` version override. */
  deviceFamily: ZmdbDeviceFamily;
  /** Absolute offset of the `ZArr` descriptor block. */
  zarrOffset: number;
  /** Number of descriptors parsed. */
  descriptorCount: number;
  /** Number of index-table entries. */
  indexEntryCount: number;
}
