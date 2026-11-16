/**
 * ZMDB schema identifiers. The upper byte of an atom ID selects the
 * record layout; the lower 24 bits identify the individual atom.
 */
export const Schema = {
  Music: 0x01,
  Video: 0x02,
  Picture: 0x03,
  Filename: 0x05,
  Album: 0x06,
  Playlist: 0x07,
  Artist: 0x08,
  Genre: 0x09,
  VideoTitle: 0x0a,
  PhotoAlbum: 0x0b,
  Collection: 0x0c,
  PodcastShow: 0x0f,
  PodcastEpisode: 0x10,
  AudiobookTitle: 0x11,
  AudiobookTrack: 0x12,
} as const;

export type ZmdbSchema = (typeof Schema)[keyof typeof Schema];

/** `ZMDB` magic at offset 0. */
export const ZMDB_MAGIC = 'ZMDB';

/** `ZMed` header magic at offset 0x20. */
export const ZMED_MAGIC = 'ZMed';

/** `ZArr` descriptor-block magic, searched from offset 0x30. */
export const ZARR_MAGIC = 'ZArr';

/** Offset of the `ZMed` header. */
export const ZMED_OFFSET = 0x20;

/** Number of 20-byte descriptors in the `ZArr` block. */
export const DESCRIPTOR_COUNT = 96;

/** Size of one descriptor entry. */
export const DESCRIPTOR_SIZE = 20;

/** Size of one index-table entry (atom id + record offset). */
export const INDEX_ENTRY_SIZE = 8;

/**
 * Fixed-size portion of each schema's record, before the variable-length
 * strings and backwards varints. Zune HD layouts.
 */
export const ENTRY_SIZES_HD: Record<number, number> = {
  [Schema.Music]: 32,
  [Schema.Video]: 32,
  [Schema.Picture]: 24,
  [Schema.Filename]: 8,
  [Schema.Album]: 20,
  [Schema.Playlist]: 12,
  [Schema.Artist]: 4,
  [Schema.Genre]: 1,
  [Schema.VideoTitle]: 4,
  [Schema.PhotoAlbum]: 12,
  [Schema.Collection]: 12,
  [Schema.PodcastShow]: 8,
  [Schema.PodcastEpisode]: 32,
  [Schema.AudiobookTitle]: 8,
  [Schema.AudiobookTrack]: 36,
};

/**
 * Fixed-size portion of each schema's record. Classic layouts
 * (Zune 30/80/120 and the flash models).
 */
export const ENTRY_SIZES_CLASSIC: Record<number, number> = {
  [Schema.Music]: 28,
  [Schema.Video]: 32,
  [Schema.Picture]: 24,
  [Schema.Filename]: 8,
  [Schema.Album]: 12,
  [Schema.Playlist]: 12,
  [Schema.Artist]: 1,
  [Schema.Genre]: 1,
  [Schema.VideoTitle]: 4,
  [Schema.PhotoAlbum]: 12,
  [Schema.Collection]: 12,
  [Schema.PodcastShow]: 8,
  [Schema.PodcastEpisode]: 32,
  [Schema.AudiobookTitle]: 8,
  [Schema.AudiobookTrack]: 36,
};

/** Descriptor index to schema mapping for Zune HD. */
export const HD_DESCRIPTOR_MAP: Record<number, number> = {
  1: Schema.Music,
  11: Schema.Playlist,
  12: Schema.Video,
  16: Schema.Picture,
  19: Schema.PodcastEpisode,
  26: Schema.AudiobookTrack,
};

/** Descriptor index to schema mapping for classic Zunes. */
export const CLASSIC_DESCRIPTOR_MAP: Record<number, number> = {
  1: Schema.Music,
  2: Schema.Playlist,
  12: Schema.Video,
};

/** Backwards-varint field IDs used by podcast records. */
export const PodcastField = {
  Description: 0x41,
  Filename: 0x44,
  Url: 0x45,
  Author: 0x46,
} as const;

/** Backwards-varint field IDs used by album, artist and track records. */
export const VarintField = {
  Guid: 0x14,
  Filename: 0x44,
  DiscNumber: 0x6c,
} as const;

/** `ZMed` format version reported by Zune HD databases. */
export const ZMED_VERSION_HD = 5;

/** `ZMed` format version reported by classic Zune databases. */
export const ZMED_VERSION_CLASSIC = 2;
