import { DataType, ObjectProperty } from '../mtp/constants/index.js';
import type { MtpObjectMetadata, MtpPropValue } from '../mtp/types.js';

/** Build the property list for a music track object. */
export function buildTrackProps(metadata: MtpObjectMetadata): MtpPropValue[] {
  const props: MtpPropValue[] = [];
  const add = (property: number, type: MtpPropValue['type'], value: MtpPropValue['value'] | undefined): void => {
    if (value === undefined || value === '') return;
    props.push({ property, type, value });
  };

  add(ObjectProperty.Name, DataType.STR, metadata.name);
  add(ObjectProperty.Artist, DataType.STR, metadata.artist);
  add(ObjectProperty.AlbumName, DataType.STR, metadata.albumName);
  add(ObjectProperty.AlbumArtist, DataType.STR, metadata.albumArtist);
  add(ObjectProperty.Genre, DataType.STR, metadata.genre);
  add(ObjectProperty.Track, DataType.UINT16, metadata.track);
  add(ObjectProperty.Duration, DataType.UINT32, metadata.duration);
  add(ObjectProperty.DateAuthored, DataType.STR, metadata.dateAuthored);
  add(ObjectProperty.OriginalDate, DataType.STR, metadata.originalDate);
  add(ObjectProperty.MetaGenre, DataType.UINT16, metadata.metaGenre);
  add(ObjectProperty.ArtistId, DataType.UINT32, metadata.artistId);

  // Artwork is deliberately not written here. The device keeps one sample per
  // album object (`RepresentativeSample*`), which is where the reference
  // implementation writes it; duplicating the image onto every track object
  // stores the same bytes once per track and renders no tile.

  return props;
}

/** Build the property list for an artist object. */
export function buildArtistProps(name: string): MtpPropValue[] {
  return [{ property: ObjectProperty.Name, type: DataType.STR, value: name }];
}

/** Build the property list for an album object. */
export function buildAlbumProps(album: {
  name: string;
  albumArtist?: string;
  artistId?: number;
  dateAuthored?: string;
}): MtpPropValue[] {
  const props: MtpPropValue[] = [
    { property: ObjectProperty.Name, type: DataType.STR, value: album.name },
  ];
  if (album.albumArtist) {
    // The album carries the artist as a plain string as well as by id. The
    // reference sets both (`zune-manager.js:602-608`); with only
    // `AlbumArtist` the device lists the album but shows its artist as
    // unknown.
    props.push({ property: ObjectProperty.Artist, type: DataType.STR, value: album.albumArtist });
    props.push({ property: ObjectProperty.AlbumArtist, type: DataType.STR, value: album.albumArtist });
  }
  if (album.artistId) {
    props.push({ property: ObjectProperty.ArtistId, type: DataType.UINT32, value: album.artistId });
  }
  if (album.dateAuthored) {
    props.push({ property: ObjectProperty.DateAuthored, type: DataType.STR, value: album.dateAuthored });
  }
  return props;
}

/** Build the property list for a podcast series (`.ser`) object. */
export function buildPodcastSeriesProps(show: {
  name: string;
  feedUrl?: string;
  author?: string;
  description?: string;
}): MtpPropValue[] {
  const props: MtpPropValue[] = [
    { property: ObjectProperty.Name, type: DataType.STR, value: show.name },
    { property: ObjectProperty.SeriesName, type: DataType.STR, value: show.name },
    { property: ObjectProperty.IsPodcast, type: DataType.UINT8, value: 1 },
    { property: ObjectProperty.PodcastDA9D, type: DataType.UINT32, value: 1 },
  ];
  if (show.feedUrl) {
    props.push({ property: ObjectProperty.URLSource, type: DataType.AUINT16, value: show.feedUrl });
  }
  if (show.author) {
    props.push({ property: ObjectProperty.Artist, type: DataType.STR, value: show.author });
  }
  if (show.description) {
    props.push({ property: ObjectProperty.Description, type: DataType.AUINT16, value: show.description });
  }
  return props;
}

/** Build the property list for a podcast episode object. */
export function buildEpisodeProps(episode: {
  name: string;
  seriesHandle: number;
  seriesName?: string;
  url?: string;
  duration?: number;
  dateAuthored?: string;
  description?: string;
}): MtpPropValue[] {
  const props: MtpPropValue[] = [
    { property: ObjectProperty.Name, type: DataType.STR, value: episode.name },
    { property: ObjectProperty.SeriesHandle, type: DataType.UINT32, value: episode.seriesHandle },
    { property: ObjectProperty.PodcastDA9B, type: DataType.UINT8, value: 0 },
    { property: ObjectProperty.MetaGenre, type: DataType.UINT16, value: 64 },
  ];
  if (episode.seriesName) {
    props.push({ property: ObjectProperty.SeriesName, type: DataType.STR, value: episode.seriesName });
  }
  if (episode.url) {
    props.push({ property: ObjectProperty.URLSource, type: DataType.AUINT16, value: episode.url });
  }
  if (episode.duration !== undefined) {
    props.push({ property: ObjectProperty.Duration, type: DataType.UINT32, value: episode.duration });
  }
  if (episode.dateAuthored) {
    props.push({ property: ObjectProperty.DateAuthored, type: DataType.STR, value: episode.dateAuthored });
  }
  if (episode.description) {
    props.push({ property: ObjectProperty.Description, type: DataType.AUINT16, value: episode.description });
  }
  return props;
}
