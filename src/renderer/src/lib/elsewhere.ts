import {
  editionless,
  inLibraryIndex,
  titleIndexOf,
  trackArtists,
  type ListeningEvent,
  type MediaIndexPools,
} from "@shared/model";

/**
 * HEARD ELSEWHERE (0.8.0, the History screen's Elsewhere tab): the artists the
 * record met away from the library — through AirPlay, a cast, the streamer's
 * own services, or on internet radio — and how each relates to what the
 * library holds. ONE list, of artists (user, 2026-09-11, on his own record:
 * the tracks and radio songs were "largely unknown to me; artists I
 * recognize", and what he wants of a row is "does it relate to something I
 * own; get more information on it"). Pure; the view sorts and filters.
 *
 * A track heard through a source and a song a station announced are the same
 * item here, music met away from the library, keyed by content, so one song
 * heard on AirPlay and on a station is one line with both places on it. A
 * station's announcement is a sighting, not a measured play; "heard" counts
 * both, which is honest enough at this altitude.
 */
export interface HeardTrack {
  key: string;
  title: string;
  artist: string | null;
  album: string | null;
  /** Where it was heard — sources (AirPlay, a service) and stations, most first. */
  where: string[];
  heard: number;
  lastAt: number;
  /** The library holds this track (content identity). */
  owned: boolean;
}
export interface HeardArtist {
  key: string;
  name: string;
  /** Most heard first. */
  tracks: HeardTrack[];
  heard: number;
  lastAt: number;
  /** Sources and stations across the tracks, most heard first. */
  where: string[];
  /** Albums by this artist in the library (the album-artist credit). */
  albums: number;
  /** Tracks in the library that credit them as a performer — a guest spot on
   *  someone else's album, a loose single. */
  credits: number;
  /** THE LIBRARY'S OWN RULE FOR AN ARTIST PAGE, nothing looser: albums as the
   *  album artist, or a performer credit on a track. The server's bare artist
   *  index used to count too, and it lists names its tags mention that no
   *  album or track in the index credits — "in your library" with a Go to
   *  artist that landed on an empty lens (user, 2026-09-12: Ellie Goulding,
   *  John Legend). */
  inLibrary: boolean;
  /** Of the tracks heard, how many the library holds. */
  ownedTracks: number;
}
export interface Heard {
  artists: HeardArtist[];
  /** The sources seen (AirPlay, a service…), most heard first. */
  sources: string[];
  /** Distinct stations that announced something. */
  stations: number;
}

/** A station's announcement as artist and song. Stations pack both into one
 *  "Artist - Song" text; the record keeps it raw and this reads it at display
 *  time (the record's rule: normalization is the reader's job). */
export function splitRadioTitle(
  title: string,
  artist: string | null,
): { artist: string | null; song: string } {
  if (artist) return { artist, song: title.trim() };
  const i = title.indexOf(" - ");
  return i > 0
    ? { artist: title.slice(0, i).trim(), song: title.slice(i + 3).trim() }
    : { artist: null, song: title.trim() };
}

const lc = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();

/** A tally of names, read back most-counted first. */
class Tally {
  private counts = new Map<string, number>();
  add(name: string, n = 1): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + n);
  }
  get size(): number {
    return this.counts.size;
  }
  entries(): Array<[string, number]> {
    return [...this.counts.entries()].sort((a, b) => b[1] - a[1]);
  }
  list(): string[] {
    return this.entries().map(([name]) => name);
  }
}

export function heardElsewhere(
  events: readonly ListeningEvent[],
  pools: readonly MediaIndexPools[] | null,
): Heard {
  const index = titleIndexOf(pools ?? []);
  // the library's artists by NAME, as the Artists lens counts them: album-artist
  // credits, and performer credits on tracks (a featured singer has a page with
  // their one track). Not the server's artist containers: those are tag-derived
  // and can name someone nothing in the index credits.
  const albumsBy = new Map<string, number>();
  const creditsBy = new Map<string, number>();
  for (const pool of pools ?? []) {
    for (const a of pool.albums) {
      const k = lc(a.artist);
      if (k) albumsBy.set(k, (albumsBy.get(k) ?? 0) + 1);
    }
    for (const t of pool.tracks)
      for (const name of trackArtists(t)) {
        const k = lc(name);
        if (k) creditsBy.set(k, (creditsBy.get(k) ?? 0) + 1);
      }
  }

  const tracks = new Map<string, HeardTrack & { places: Tally }>();
  const sources = new Tally();
  const stations = new Set<string>();
  const note = (
    title: string,
    artist: string | null,
    album: string | null,
    place: string,
    at: number,
    owned: () => boolean,
  ): void => {
    const key = `${editionless(title)}|${lc(artist)}`;
    let t = tracks.get(key);
    if (!t) {
      t = {
        key,
        title,
        artist,
        album,
        where: [],
        heard: 0,
        lastAt: 0,
        owned: owned(),
        places: new Tally(),
      };
      tracks.set(key, t);
    }
    t.heard += 1;
    t.places.add(place);
    if (at >= t.lastAt) {
      t.lastAt = at;
      t.album = album ?? t.album;
    }
  };
  for (const e of events) {
    if (e.kind === "external" && e.title) {
      const source = e.source ?? "Another source";
      sources.add(source);
      note(e.title, e.artist, e.album, source, e.at, () =>
        inLibraryIndex(index, e.title ?? "", e.artist),
      );
    } else if (e.kind === "radio-track" && e.title) {
      const { artist, song } = splitRadioTitle(e.title, e.artist);
      const station = e.station ?? "Internet radio";
      if (e.station) stations.add(e.station);
      note(
        song,
        artist,
        null,
        station,
        e.at,
        () =>
          // a station that sends "Song - Artist" instead is matched the other way round
          inLibraryIndex(index, song, artist) ||
          (artist != null && inLibraryIndex(index, artist, song)),
      );
    }
  }

  const byArtist = new Map<string, Array<HeardTrack & { places: Tally }>>();
  for (const t of tracks.values()) {
    const k = lc(t.artist) || "unknown";
    const list = byArtist.get(k);
    if (list) list.push(t);
    else byArtist.set(k, [t]);
  }
  const artists: HeardArtist[] = [...byArtist.entries()].map(([key, list]) => {
    list.sort((a, b) => b.heard - a.heard || b.lastAt - a.lastAt);
    const where = new Tally();
    for (const t of list) for (const [place, n] of t.places.entries()) where.add(place, n);
    const albums = albumsBy.get(key) ?? 0;
    const credits = creditsBy.get(key) ?? 0;
    return {
      key,
      name: list[0].artist ?? "Unknown artist",
      tracks: list.map(({ places, ...t }) => ({ ...t, where: places.list() })),
      heard: list.reduce((n, t) => n + t.heard, 0),
      lastAt: Math.max(...list.map((t) => t.lastAt)),
      where: where.list(),
      albums,
      credits,
      inLibrary: albums > 0 || credits > 0,
      ownedTracks: list.filter((t) => t.owned).length,
    };
  });

  return { artists, sources: sources.list(), stations: stations.size };
}
