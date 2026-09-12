import {
  editionless,
  inLibraryIndex,
  isListen,
  titleIndexOf,
  type ListeningEvent,
  type MediaIndexPools,
} from "@shared/model";

/**
 * HEARD ELSEWHERE (0.8.0, the History screen's Elsewhere section): the music the
 * record heard outside the library. External sources (AirPlay, casts, the
 * streamer's own services) by their tracks and their artists; internet radio
 * by the songs its stations announced. Each is marked with whether the library
 * holds it (inLibraryIndex, content identity). Pure; the view sorts and filters.
 *
 * Counts are honest about what each kind of line knows: an external track was
 * PLAYED (heard, and listens among those by the house predicate); a radio song
 * was only ANNOUNCED, so its count is sightings, never listens.
 */
export interface HeardTrack {
  key: string;
  title: string;
  artist: string | null;
  album: string | null;
  source: string;
  heard: number;
  listens: number;
  lastAt: number;
  owned: boolean;
}
export interface HeardArtist {
  key: string;
  name: string;
  tracks: number;
  albums: number;
  heard: number;
  lastAt: number;
  /** Of its tracks, how many the library holds. */
  owned: number;
  /** The most-heard track, for the row's picture. */
  top: HeardTrack;
}
export interface HeardRadioSong {
  key: string;
  song: string;
  artist: string | null;
  stations: string[];
  heard: number;
  lastAt: number;
  owned: boolean;
}
export interface Heard {
  tracks: HeardTrack[];
  artists: HeardArtist[];
  radio: HeardRadioSong[];
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

export function heardElsewhere(
  events: readonly ListeningEvent[],
  pools: readonly MediaIndexPools[] | null,
): Heard {
  const index = titleIndexOf(pools ?? []);
  const tracks = new Map<string, HeardTrack>();
  const radio = new Map<string, HeardRadioSong>();
  const stations = new Set<string>();
  for (const e of events) {
    if (e.kind === "external" && e.title) {
      const key = `${editionless(e.title)}|${lc(e.artist)}`;
      let t = tracks.get(key);
      if (!t) {
        t = {
          key,
          title: e.title,
          artist: e.artist,
          album: e.album,
          source: e.source ?? "Another source",
          heard: 0,
          listens: 0,
          lastAt: 0,
          owned: inLibraryIndex(index, e.title, e.artist),
        };
        tracks.set(key, t);
      }
      t.heard += 1;
      if (isListen(e.playedSeconds, e.duration)) t.listens += 1;
      if (e.at >= t.lastAt) {
        t.lastAt = e.at;
        t.album = e.album ?? t.album;
        t.source = e.source ?? t.source;
      }
    } else if (e.kind === "radio-track" && e.title) {
      const { artist, song } = splitRadioTitle(e.title, e.artist);
      const key = `${lc(song)}|${lc(artist)}`;
      let r = radio.get(key);
      if (!r) {
        r = {
          key,
          song,
          artist,
          stations: [],
          heard: 0,
          lastAt: 0,
          // a station that sends "Song - Artist" instead is matched the other way round
          owned:
            inLibraryIndex(index, song, artist) ||
            (artist != null && inLibraryIndex(index, artist, song)),
        };
        radio.set(key, r);
      }
      r.heard += 1;
      r.lastAt = Math.max(r.lastAt, e.at);
      if (e.station && !r.stations.includes(e.station)) r.stations.push(e.station);
      if (e.station) stations.add(e.station);
    }
  }

  const byArtist = new Map<string, HeardTrack[]>();
  for (const t of tracks.values()) {
    const k = lc(t.artist) || "unknown";
    const list = byArtist.get(k);
    if (list) list.push(t);
    else byArtist.set(k, [t]);
  }
  const artists: HeardArtist[] = [...byArtist.entries()].map(([key, list]) => {
    const top = list.reduce((a, b) => (b.heard > a.heard ? b : a));
    return {
      key,
      name: top.artist ?? "Unknown artist",
      tracks: list.length,
      albums: new Set(list.map((t) => lc(t.album)).filter(Boolean)).size,
      heard: list.reduce((n, t) => n + t.heard, 0),
      lastAt: Math.max(...list.map((t) => t.lastAt)),
      owned: list.filter((t) => t.owned).length,
      top,
    };
  });

  return {
    tracks: [...tracks.values()],
    artists,
    radio: [...radio.values()],
    stations: stations.size,
  };
}
