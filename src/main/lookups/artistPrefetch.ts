import { trackArtists, type MediaIndexPools } from "@shared/model";
import { getSettings } from "../data/persist";
import { listeningRecord } from "../data/listeningRecord";
import { artistIndex } from "../media/artistIndex";
import * as mediaIndex from "../media/mediaIndex";
import { artistCacheHasRoom, fetchArtistInfo, knowsArtist } from "./artistInfo";

/**
 * PHOTOS FETCHED AHEAD (0.13.0; Malcolm, 2026-10-24: a photo loads only on an artist page's first
 * visit). Round 7 fetched the 50 most-played; round 8 (his next email, 2026-10-25: "the fetch will
 * only tax the system the first time you link to your library") every artist in the libraries,
 * the most-played first (the listening record's library plays), then the rest by how much of the
 * library is theirs. One at a time, an artist page's own lookup but on the MusicBrainz gate's
 * speculative lane, behind anything a person is waiting on, with a pause between artists: a
 * first pass over 500 artists takes about 40 minutes, once. Only with the artist lookups on,
 * checked before every artist; an artist already asked about is skipped (a settled answer, a
 * photo or none, is never asked again: decisions/0013); and the pass stops short of the cache's
 * cap, so a very large library never pushes out its own photos. A pass runs a while after launch
 * and again a minute after the indexes change, so an artist added later is fetched too. Nothing
 * on screen changes: a row keeps the picture it drew for the session, and the photo is there the
 * next time it, or the artist's page, asks.
 */

/** The wait after launch before the first pass, so startup's own work goes first. */
const DELAY_MS = Number(process.env["TASTYTUNES_PREFETCH_DELAY_MS"] ?? 90_000);
/** The pause between artists (each lookup is two MusicBrainz requests a second apart). */
const GAP_MS = Number(process.env["TASTYTUNES_PREFETCH_GAP_MS"] ?? 2_000);
/** The wait after the indexes last changed before another pass looks for new artists. */
const SETTLE_MS = 60_000;

const keyOf = (name: string): string => name.trim().toLowerCase();

/**
 * The order the artists are fetched in: the most-played by library plays first (each as spelled
 * most), then every other artist in the libraries by their albums and tracks there, most first,
 * then by name; each once.
 */
export function prefetchOrder(
  events: ReadonlyArray<{ kind: string; artist?: unknown }>,
  pools: MediaIndexPools[],
): string[] {
  const played = new Map<string, { plays: number; spellings: Map<string, number> }>();
  for (const e of events) {
    if (e.kind !== "play" || typeof e.artist !== "string") continue;
    const name = e.artist.trim();
    if (!name) continue;
    const t = played.get(keyOf(name)) ?? { plays: 0, spellings: new Map<string, number>() };
    t.plays++;
    t.spellings.set(name, (t.spellings.get(name) ?? 0) + 1);
    played.set(keyOf(name), t);
  }
  const out = [...played.values()]
    .sort((a, b) => b.plays - a.plays)
    .map((t) => [...t.spellings.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  const seen = new Set(out.map(keyOf));
  // the libraries' artists as the Artists lens has them, each spelled as first met
  const spelled = new Map<string, string>();
  const meet = (name: string | null | undefined): void => {
    const n = name?.trim();
    if (n && !spelled.has(keyOf(n))) spelled.set(keyOf(n), n);
  };
  for (const p of pools) {
    for (const a of p.artists) meet(a.title);
    for (const a of p.albums) meet(a.artist);
    for (const t of p.tracks) for (const n of trackArtists(t)) meet(n);
  }
  const counts = artistIndex(pools);
  const weight = (k: string): number => {
    const e = counts.get(k);
    return e ? e.albums * 10 + e.tracks : 0;
  };
  const rest = [...spelled.entries()]
    .filter(([k]) => !seen.has(k))
    .sort(([a, an], [b, bn]) => weight(b) - weight(a) || an.localeCompare(bn))
    .map(([, n]) => n);
  return [...out, ...rest];
}

let started = false;
let running = false;
let again = false;
let settle: ReturnType<typeof setTimeout> | null = null;

/** Called once from whenReady; the first pass starts after DELAY_MS. */
export function startArtistPrefetch(): void {
  if (started) return;
  started = true;
  setTimeout(() => void pass(), DELAY_MS).unref?.();
}

/** The indexes changed (main/index.ts hears every status): a pass a minute after they settle,
 *  for the artists a rebuild brought. */
export function artistPrefetchAfterIndex(): void {
  if (!started) return;
  if (settle) clearTimeout(settle);
  settle = setTimeout(() => {
    settle = null;
    void pass();
  }, SETTLE_MS);
  settle.unref?.();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref?.());

async function pass(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    if (!getSettings().artistInfo) return;
    let names: string[];
    try {
      names = prefetchOrder((await listeningRecord.readAll()).events, mediaIndex.pools());
    } catch {
      return;
    }
    for (const name of names) {
      if (!getSettings().artistInfo || !artistCacheHasRoom()) return;
      if (knowsArtist(name)) continue;
      try {
        await fetchArtistInfo(name, false, "speculative");
      } catch {
        // a failed lookup is asked again by the page, or by the next pass
      }
      await sleep(GAP_MS);
    }
  } finally {
    running = false;
    if (again) {
      again = false;
      void pass();
    }
  }
}
