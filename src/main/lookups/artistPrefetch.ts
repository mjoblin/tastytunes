import { getSettings } from "../data/persist";
import { listeningRecord } from "../data/listeningRecord";
import { fetchArtistInfo, knowsArtist } from "./artistInfo";

/**
 * PHOTOS FETCHED AHEAD (0.13.0 round 7; Malcolm, 2026-10-24: a photo loads only on an artist
 * page's first visit). A while after launch, the artists played most (the listening record's
 * library plays, the 50 with the most) are looked up one at a time, an artist page's own lookup
 * but on the MusicBrainz gate's speculative lane, behind anything a person is waiting on, with a
 * pause between artists. Only with the artist lookups on, checked before every artist, and only
 * an artist not asked about before (a settled answer, a photo or none, is never asked again:
 * decisions/0013). Nothing on screen changes: a row keeps the picture it drew for the session,
 * and the photo is there the next time it, or the artist's page, asks.
 */

/** How many of the most-played artists are fetched ahead. */
export const PREFETCH_COUNT = 50;
/** The wait after launch before the first, so startup's own work goes first. */
const DELAY_MS = Number(process.env["TASTYTUNES_PREFETCH_DELAY_MS"] ?? 90_000);
/** The pause between artists (each lookup is two MusicBrainz requests a second apart). */
const GAP_MS = Number(process.env["TASTYTUNES_PREFETCH_GAP_MS"] ?? 2_000);

/** The most-played artists by library plays, most first, each as its most-played spelling. */
export function mostPlayedArtists(
  events: ReadonlyArray<{ kind: string; artist?: unknown }>,
  count = PREFETCH_COUNT,
): string[] {
  const tally = new Map<string, { plays: number; spellings: Map<string, number> }>();
  for (const e of events) {
    if (e.kind !== "play" || typeof e.artist !== "string") continue;
    const name = e.artist.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const t = tally.get(key) ?? { plays: 0, spellings: new Map<string, number>() };
    t.plays++;
    t.spellings.set(name, (t.spellings.get(name) ?? 0) + 1);
    tally.set(key, t);
  }
  return [...tally.values()]
    .sort((a, b) => b.plays - a.plays)
    .slice(0, count)
    .map((t) => [...t.spellings.entries()].sort((a, b) => b[1] - a[1])[0][0]);
}

let started = false;

/** Called once from whenReady; the fetching starts after DELAY_MS. */
export function startArtistPrefetch(): void {
  if (started) return;
  started = true;
  setTimeout(() => void prefetch(), DELAY_MS).unref?.();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref?.());

async function prefetch(): Promise<void> {
  if (!getSettings().artistInfo) return;
  let names: string[];
  try {
    names = mostPlayedArtists((await listeningRecord.readAll()).events);
  } catch {
    return;
  }
  for (const name of names) {
    if (!getSettings().artistInfo) return;
    if (knowsArtist(name)) continue;
    try {
      await fetchArtistInfo(name, false, "speculative");
    } catch {
      // a failed lookup is asked again by the page, or by the next launch
    }
    await sleep(GAP_MS);
  }
}
