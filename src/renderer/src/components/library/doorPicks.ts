import {
  type MediaIndexPools,
  type MediaNode,
  type PlayStat,
  audioAnalysisKey,
  isCompilation,
} from "@shared/model";
// the scenes' string hash: a fixed, title-made order for ties (the same library draws the same
// doors every visit)
import { hashStr } from "@/components/display/scenes/lib";

/**
 * WHAT THE LIBRARY'S DOORS SHOW (0.12.0-rc.3, his ask: "our custom entrypoints look too much like
 * the streamer's entrypoints… make ours look more exciting"). Each door is a picture of its own
 * lens drawn from the reader's library: the Albums door a crate of the most-played covers, the
 * Artists door the most-played artists, the Tracks door the waveforms of the most-played tracks
 * that have been analyzed. Ties, and a library with no listening record, fall back to an order
 * fixed by the titles (the doors never reshuffle between visits). Pure: the doors' hook feeds it
 * the pools and the record's lookup.
 */
export interface DoorPicks {
  /** Up to five albums with a cover, most played first. */
  covers: MediaNode[];
  /** Up to five albums, cover or not, for the crate of plain sleeves. */
  sleeves: MediaNode[];
  /** Up to five artist names, most played first, never a compilation's "Various Artists". */
  artists: string[];
  /** Tracks in the same order, deduplicated by content key: the waveforms' candidates. */
  tracks: MediaNode[];
  /** Every album cover in the library: an artist picture that is one of these is a cover, not
   *  a photo (main answers an artist without a photo with a cover of theirs). */
  coverArt: ReadonlySet<string>;
}

/** How many items a door draws, front first (the narrowest doors keep three). */
export const DOOR_ITEMS = 5;
/** How many ranked tracks the Tracks door asks about for a stored analysis. */
export const WAVE_CANDIDATES = 300;
/** Fewer real pictures than this and a door draws its fallback instead (a crate of two covers
 *  reads as a gap, not a crate). */
export const DOOR_MIN_PICTURES = 3;

const norm = (v: string | null | undefined): string =>
  (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** Who a track counts for: its album artist, unless that is a compilation's. */
function creditOf(t: MediaNode): string | null {
  const owner = t.albumArtist?.trim();
  if (owner && !isCompilation({ artist: owner })) return owner;
  const who = t.artist?.trim();
  return who && !isCompilation({ artist: who }) ? who : null;
}

const albumKeyOf = (title: string | null | undefined, artist: string | null | undefined): string =>
  `${norm(title)}|${norm(artist)}`;

export function pickDoorArt(
  pools: ReadonlyArray<MediaIndexPools>,
  playsOf: (t: MediaNode) => PlayStat | null,
): DoorPicks {
  const albumPlays = new Map<string, number>();
  const artistPlays = new Map<string, { name: string; plays: number }>();
  const ranked: Array<{ t: MediaNode; plays: number; tie: number }> = [];
  for (const g of pools)
    for (const t of g.tracks) {
      const plays = playsOf(t)?.plays ?? 0;
      ranked.push({ t, plays, tie: hashStr(norm(t.title)) });
      if (plays === 0) continue;
      const ak = albumKeyOf(t.album, t.albumArtist ?? t.artist);
      albumPlays.set(ak, (albumPlays.get(ak) ?? 0) + plays);
      const who = creditOf(t);
      if (!who) continue;
      const cur = artistPlays.get(norm(who));
      artistPlays.set(norm(who), { name: cur?.name ?? who, plays: (cur?.plays ?? 0) + plays });
    }
  ranked.sort((a, b) => b.plays - a.plays || a.tie - b.tie);

  // one album on two servers (the drive and a UPnP server) is one album here
  const seen = new Set<string>();
  const albums = pools
    .flatMap((g) => g.albums)
    .map((a) => ({
      a,
      key: albumKeyOf(a.title, a.albumArtist ?? a.artist),
    }))
    .map((x) => ({ ...x, plays: albumPlays.get(x.key) ?? 0, tie: hashStr(x.key) }))
    .sort((x, y) => y.plays - x.plays || x.tie - y.tie)
    .filter((x) => (seen.has(x.key) ? false : (seen.add(x.key), true)))
    .map((x) => x.a);
  const covers = albums.filter((a) => a.artUrl).slice(0, DOOR_ITEMS);
  const coverArt = new Set<string>();
  for (const g of pools) for (const a of g.albums) if (a.artUrl) coverArt.add(a.artUrl);
  const sleeves = albums.slice(0, DOOR_ITEMS);

  // the played artists, then the artists of the albums the crate shows, then the index's own
  const names: string[] = [];
  const taken = new Set<string>();
  const take = (name: string | null | undefined): void => {
    const n = name?.trim();
    if (!n || names.length >= DOOR_ITEMS || taken.has(norm(n)) || isCompilation({ artist: n }))
      return;
    taken.add(norm(n));
    names.push(n);
  };
  for (const { name } of [...artistPlays.values()].sort((a, b) => b.plays - a.plays)) take(name);
  for (const a of covers) take(a.albumArtist ?? a.artist);
  for (const g of pools) for (const a of g.artists) take(a.title);

  const keys = new Set<string>();
  const tracks: MediaNode[] = [];
  for (const { t } of ranked) {
    if (tracks.length >= WAVE_CANDIDATES) break;
    const k = audioAnalysisKey(t);
    if (keys.has(k)) continue;
    keys.add(k);
    tracks.push(t);
  }
  return { covers, sleeves, artists: names, tracks, coverArt };
}

/** The Artists door's faces, front first: the artists with a photo ahead of those shown by a
 *  cover, each kind in the order of their plays, so the door shows people where the Albums door
 *  shows covers (his most-played artist's cover was the front of both doors). */
export function faceOrder<T extends { pic: string | null }>(
  faces: ReadonlyArray<T>,
  coverArt: ReadonlySet<string>,
): T[] {
  const photo = (f: T): number => (f.pic != null && !coverArt.has(f.pic) ? 0 : 1);
  return [...faces].sort((a, b) => photo(a) - photo(b));
}

/** A stored envelope (0..1000) as `n` bars of its loudest moments, each 0..1 of the track's own
 *  peak: the Tracks door's waveform, read from the analysis, never drawn from nothing. */
export function waveBars(peakQ: ReadonlyArray<number>, n: number): number[] {
  if (peakQ.length === 0 || n <= 0) return [];
  let max = 0;
  for (const v of peakQ) if (v > max) max = v;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * peakQ.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * peakQ.length) / n));
    let m = 0;
    for (let j = from; j < to && j < peakQ.length; j++) if (peakQ[j] > m) m = peakQ[j];
    out.push(max > 0 ? m / max : 0);
  }
  return out;
}

/** An artist's monogram: the first letters of the first two words that carry the name, a
 *  leading "The" and the joining words dropped ("Siouxsie and the Banshees" is SB). */
export function monogram(name: string): string {
  const words = name
    .replace(/^the\s+/i, "")
    .split(/\s+/)
    .filter(
      (w, i) => /[\p{L}\p{N}]/u.test(w) && (i === 0 || !/^(and|the|of|a|an|n'|'n')$/i.test(w)),
    );
  return words
    .slice(0, 2)
    .map((w) => [...w.replace(/^[^\p{L}\p{N}]+/u, "")][0]?.toUpperCase() ?? "")
    .join("");
}
