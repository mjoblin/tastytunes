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
}

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
