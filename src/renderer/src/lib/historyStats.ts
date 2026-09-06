import {
  type ListeningEvent,
  type ListeningPlayEvent,
  isHiRes,
  isListen,
  playKey,
} from "@shared/model";
import { fmtDuration } from "@/lib/format";

/**
 * The listening record's FIGURES (0.8.0, the Stats round) — one home, pure.
 * The History Stats view reads a period through it; the Timeline's month
 * dividers read a month through it; the year card will draw from it. A
 * library play is a play; a listen is the house predicate (isListen); radio
 * and external lines contribute time to "where it played" but never to plays.
 */
export interface TopEntry {
  name: string;
  sub: string | null;
  /** The album an entry lives on (a track's, or the album itself) — the Library landing. */
  album: string | null;
  plays: number;
  seconds: number;
}

export interface ListeningStats {
  /** Library plays, listens among them, and their seconds. */
  plays: number;
  listens: number;
  seconds: number;
  /** Time heard from the radio and from external sources; radio songs sighted. */
  radioSeconds: number;
  externalSeconds: number;
  radioSongs: number;
  /** Distinct library albums, artists and tracks played. */
  albums: number;
  artists: number;
  tracks: number;
  /** Days with any listening. */
  days: number;
  topAlbums: TopEntry[];
  topArtists: TopEntry[];
  topTracks: TopEntry[];
  /** Stations by time heard; `plays` carries the songs sighted there. */
  topStations: TopEntry[];
  /** Where it played: Library, Radio, each external source by name — the
   *  seconds heard there and a count in that source's own unit (library plays,
   *  external tracks, radio songs sighted). */
  bySource: Array<{ source: string; seconds: number; count: number; unit: string }>;
  /** Library seconds by the file's quality, hi-res being a subset of lossless. */
  quality: { lossless: number; lossy: number; unknown: number; hires: number };
  /** Seconds by weekday × hour, Monday first (7 × 24). */
  byWeekdayHour: number[];
  /** Seconds by day (dayStart ms), every kind. */
  byDay: Map<number, number>;
}

export const dayStartOf = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
export const monthStartOf = (ms: number): number => {
  const d = new Date(ms);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const secondsOf = (e: ListeningEvent): number =>
  "playedSeconds" in e && typeof e.playedSeconds === "number" ? e.playedSeconds : 0;

/** The Source label for a line: Library, Radio, or the external source's name. */
export const sourceNameOf = (e: ListeningEvent): string =>
  e.kind === "play" ? "Library" : e.kind === "external" ? (e.source ?? "Another source") : "Radio";

const TOP = 8;

function top(map: Map<string, TopEntry>): TopEntry[] {
  return [...map.values()]
    .sort((a, b) => b.plays - a.plays || b.seconds - a.seconds || a.name.localeCompare(b.name))
    .slice(0, TOP);
}

export function statsFor(
  events: readonly ListeningEvent[],
  period?: { from: number; to: number } | null,
): ListeningStats {
  const albums = new Map<string, TopEntry>();
  const artists = new Map<string, TopEntry>();
  const tracks = new Map<string, TopEntry>();
  const stations = new Map<string, TopEntry>();
  const bySource = new Map<string, { seconds: number; count: number; unit: string }>();
  const byDay = new Map<number, number>();
  const byWeekdayHour = new Array<number>(7 * 24).fill(0);
  const quality = { lossless: 0, lossy: 0, unknown: 0, hires: 0 };
  let plays = 0;
  let listens = 0;
  let seconds = 0;
  let radioSeconds = 0;
  let externalSeconds = 0;
  let radioSongs = 0;
  for (const e of events) {
    if (period && (e.at < period.from || e.at >= period.to)) continue;
    const secs = secondsOf(e);
    if (secs > 0) {
      const d = dayStartOf(e.at);
      byDay.set(d, (byDay.get(d) ?? 0) + secs);
      const at = new Date(e.at);
      byWeekdayHour[((at.getDay() + 6) % 7) * 24 + at.getHours()] += secs;
      const src = sourceNameOf(e);
      const row = bySource.get(src) ?? {
        seconds: 0,
        count: 0,
        unit: e.kind === "radio-session" ? "songs heard" : "tracks",
      };
      row.seconds += secs;
      if (e.kind === "play" || e.kind === "external") row.count += 1;
      bySource.set(src, row);
    }
    if ((e.kind === "radio-session" || e.kind === "radio-track") && e.station) {
      const row = stations.get(e.station) ?? {
        name: e.station,
        sub: null,
        album: null,
        plays: 0,
        seconds: 0,
      };
      if (e.kind === "radio-session") row.seconds += secs;
      else row.plays += 1;
      stations.set(e.station, row);
    }
    if (e.kind === "radio-track") {
      radioSongs += 1;
      const row = bySource.get("Radio") ?? { seconds: 0, count: 0, unit: "songs heard" };
      row.count += 1;
      bySource.set("Radio", row);
    }
    if (e.kind === "radio-session") radioSeconds += secs;
    if (e.kind === "external") externalSeconds += secs;
    if (e.kind !== "play") continue;
    const ev: ListeningPlayEvent = e;
    plays += 1;
    seconds += secs;
    if (isListen(ev.playedSeconds, ev.duration)) listens += 1;
    if (ev.lossless === true) {
      quality.lossless += secs;
      if (isHiRes({ bits: ev.bitDepth, rate: ev.sampleRate })) quality.hires += secs;
    } else if (ev.lossless === false) quality.lossy += secs;
    else quality.unknown += secs;
    const bump = (
      m: Map<string, TopEntry>,
      key: string,
      name: string,
      sub: string | null,
      album: string | null,
    ): void => {
      const row = m.get(key) ?? { name, sub, album, plays: 0, seconds: 0 };
      row.plays += 1;
      row.seconds += secs;
      m.set(key, row);
    };
    if (ev.album) bump(albums, playKey(null, ev.artist, ev.album), ev.album, ev.artist, ev.album);
    if (ev.artist) bump(artists, playKey(null, ev.artist, null), ev.artist, null, null);
    bump(tracks, playKey(ev.title, ev.artist, ev.album), ev.title, ev.artist, ev.album);
  }
  return {
    plays,
    listens,
    seconds,
    radioSeconds,
    externalSeconds,
    radioSongs,
    albums: albums.size,
    artists: artists.size,
    tracks: tracks.size,
    days: byDay.size,
    topAlbums: top(albums),
    topArtists: top(artists),
    topTracks: top(tracks),
    topStations: [...stations.values()]
      .sort((a, b) => b.seconds - a.seconds || b.plays - a.plays || a.name.localeCompare(b.name))
      .slice(0, TOP),
    bySource: [...bySource.entries()]
      .map(([source, r]) => ({ source, ...r }))
      .sort((a, b) => b.seconds - a.seconds),
    quality,
    byWeekdayHour,
    byDay,
  };
}

/** A month's one-line summary for the Timeline's divider: plays, time, the
 *  most-played album. Null when the month has no library plays. */
export function monthLine(stats: ListeningStats): string | null {
  if (stats.plays === 0 && stats.radioSeconds === 0 && stats.externalSeconds === 0) return null;
  const parts: string[] = [];
  if (stats.plays > 0)
    parts.push(`${stats.plays.toLocaleString()} ${stats.plays === 1 ? "play" : "plays"}`);
  const total = stats.seconds + stats.radioSeconds + stats.externalSeconds;
  if (total > 0) parts.push(fmtDuration(total));
  if (stats.topAlbums[0]) parts.push(`most: ${stats.topAlbums[0].name}`);
  return parts.join(" · ");
}
