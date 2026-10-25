// What the app looks up about the music on the internet: artist, album and track context
// (MusicBrainz, Wikipedia), a disc's track list, and lyrics.

// ------------------------------------------------------------- artist context

export interface ArtistInfo {
  /** MusicBrainz's canonical name for the matched artist. */
  name: string;
  /** Wikipedia summary extract, when the chain resolved one. */
  summary: string | null;
  wikipediaUrl: string | null;
  musicbrainzUrl: string | null;
  /** The artist's photo: the lead picture of their Wikipedia article (0.11.0), or null when
   *  the article has none. Absent on an answer cached before it was read (asked again). */
  image?: string | null;
}

/**
 * AN ARTIST'S CHOSEN PICTURE (0.13.0 round 7; a user's ask, like Plexamp: Wikipedia's lead image is
 * often a poor stage photo). Within decisions/0013 (a photo changes only when asked: choosing is
 * asking, and nothing replaces a choice but another, or a reset) and 0001 (no API keys): another
 * image from the artist's Wikipedia article, one of their album covers in the library, or a
 * picture file (copied into the app's data, so moving the original loses nothing). It outranks
 * every other picture: the page's, the Artists view's rows, the Library's Artists card.
 */
export type ArtistChoice =
  /** An image from the artist's Wikipedia article (its address on Wikimedia). */
  | { kind: "image"; url: string }
  /** One of the artist's album covers: the album by server and title, so a cover whose address
   *  moves (the streamer's drive, after a standby) is found again; `url` as it was chosen. */
  | { kind: "cover"; url: string; album: string; serverUdn: string | null }
  /** A picture file, copied into the app's data under `file`. */
  | { kind: "file"; file: string };

export interface AlbumInfo {
  /** MusicBrainz's canonical title for the matched release group. */
  title: string;
  /** Year of first release, e.g. "2011". */
  year: string | null;
  /** Release-group primary type, e.g. "Album", "EP". */
  type: string | null;
  /** Label of the earliest release, when known. */
  label: string | null;
  /** MusicBrainz genre tags, most-voted first. */
  genres: string[];
  /** Release-level relationship credits (producer etc.), when MB has them. */
  credits: Array<{ role: string; name: string }>;
  /** Wikipedia summary extract, when the chain resolved one. */
  summary: string | null;
  wikipediaUrl: string | null;
  musicbrainzUrl: string | null;
}

export interface TrackInfoQuery {
  artist: string;
  title: string;
  album: string | null;
  /** Playing length in seconds, if known — disambiguates same-titled recordings. */
  duration: number | null;
}

export interface TrackCredit {
  /** Human role: an instrument name, "Lead vocals", "Producer", "Composer"… */
  role: string;
  name: string;
}

/**
 * Recording-level credits for the playing track — who is actually ON it.
 * Groups mirror how MusicBrainz relates people to a recording: performers
 * (instrument/vocal relationships on the recording), production (producer,
 * engineering, mixing), and writing (composer/lyricist from the linked work).
 * Any group can be empty; coverage varies a lot by catalogue era.
 */
export interface TrackInfo {
  /** MusicBrainz's canonical title for the matched recording. */
  title: string;
  performers: TrackCredit[];
  production: TrackCredit[];
  writing: TrackCredit[];
  musicbrainzUrl: string | null;
}

// ------------------------------------------------------------------- lyrics

export interface LyricsQuery {
  artist: string;
  title: string;
  album: string | null;
  /** Track length in seconds, if known — LRCLIB uses it for exact matching. */
  duration: number | null;
}

export interface LyricsResult {
  plain: string | null;
  /** LRC-format synced lyrics ("[mm:ss.xx] line"), when the record has them. */
  synced: string | null;
  instrumental: boolean;
}

// ------------------------------------------------------------------ disc tracks

/** One track of a disc as MusicBrainz lists it (0.10.0, the CD): its number, its title and
 *  its length when the release gives one. */
export interface DiscTrack {
  n: number;
  title: string;
  secs: number | null;
}

/** A disc's track list from the MusicBrainz release its cover came from: the medium whose
 *  track count (and, among equals, whose length) matches the disc in the player. */
export interface DiscTracks {
  releaseId: string;
  tracks: DiscTrack[];
}
