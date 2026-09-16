import {
  albumTally,
  nameSortKey,
  playKey,
  REDISCOVER_QUIET_DAYS,
  type MediaIndexPools,
  type MediaNode,
  type PlayStats,
} from "@shared/model";

/**
 * The History screen's REDISCOVER sections (0.8.0): albums worth coming back to,
 * read from the record AND the library, because the record alone is too young
 * to say much for months. Pure, and WHOLE: every album that qualifies, since
 * the view shows two rows and expands on ask.
 *
 * - STARTED, NEVER FINISHED: played, but the tracks listened to across every
 *   run never reached the album's middle, and nothing since for a week.
 * - MORE FROM ARTISTS YOU PLAY: unplayed albums by your most-played artists.
 * - NOT HEARD IN A WHILE: played, then left for REDISCOVER_QUIET_DAYS (the
 *   MCP's history_rediscover rule, through the same albumTally).
 * - NEVER PLAYED: no recorded play since the record began (history_unplayed's
 *   rule and its order, artist then title).
 */
export interface ShelfAlbum {
  album: MediaNode;
  plays: number;
  lastAt: number;
  tracks: number;
  /** Distinct tracks listened to, across every run (the unfinished section). */
  reached: number;
}
export interface Shelves {
  unfinished: ShelfAlbum[];
  moreFrom: ShelfAlbum[];
  quiet: ShelfAlbum[];
  neverPlayed: ShelfAlbum[];
}

const DAY = 86_400_000;
/** Started, never finished: nothing since for this long. */
export const UNFINISHED_QUIET_DAYS = 7;
/** An album shorter than this has no middle worth coming back for. */
const UNFINISHED_MIN_TRACKS = 4;
/** More from artists you play: this many of your most-played artists. */
const TOP_ARTISTS = 12;

const lc = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();
const VARIOUS = /^various( artists)?$/;

export function shelvesFor(
  pools: readonly MediaIndexPools[],
  stats: PlayStats,
  now: number,
): Shelves {
  // one row per album, twin copies (two servers, two editions) once
  const seen = new Set<string>();
  const rows: ShelfAlbum[] = [];
  for (const pool of pools) {
    // albumTracksOf keeps only tracks whose album title matches, so handing it
    // that title's tracks alone gives the same answer without a pass over the
    // whole pool per album (thousands of tracks, hundreds of albums)
    const byAlbum = new Map<string, MediaNode[]>();
    for (const t of pool.tracks) {
      const k = lc(t.album);
      const list = byAlbum.get(k);
      if (list) list.push(t);
      else byAlbum.set(k, [t]);
    }
    for (const album of pool.albums) {
      const id = `${lc(album.title)}|${lc(album.artist)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const t = albumTally(
        album,
        { albums: pool.albums, tracks: byAlbum.get(lc(album.title)) ?? [] },
        stats,
      );
      rows.push({ album, plays: t.plays, lastAt: t.lastAt, tracks: t.tracks, reached: 0 });
    }
  }

  const unfinished = rows
    .filter(
      (r) =>
        r.plays > 0 &&
        r.tracks >= UNFINISHED_MIN_TRACKS &&
        r.lastAt < now - UNFINISHED_QUIET_DAYS * DAY,
    )
    .map((r) => {
      const runs = stats.albumRuns[playKey(null, null, r.album.title)] ?? [];
      return { ...r, reached: new Set(runs.flatMap((x) => x.listened)).size };
    })
    .filter((r) => r.reached < Math.ceil(r.tracks / 2))
    .sort((a, b) => b.lastAt - a.lastAt);

  const artistPlays = new Map<string, number>();
  for (const r of rows) {
    const a = lc(r.album.artist);
    if (r.plays > 0 && a && !VARIOUS.test(a))
      artistPlays.set(a, (artistPlays.get(a) ?? 0) + r.plays);
  }
  const rank = new Map(
    [...artistPlays.entries()]
      .sort((x, y) => y[1] - x[1])
      .slice(0, TOP_ARTISTS)
      .map(([a], i) => [a, i]),
  );
  const moreFrom = rows
    .filter((r) => r.plays === 0 && rank.has(lc(r.album.artist)))
    .sort(
      (x, y) =>
        (rank.get(lc(x.album.artist)) ?? TOP_ARTISTS) -
          (rank.get(lc(y.album.artist)) ?? TOP_ARTISTS) ||
        (Number(y.album.year) || 0) - (Number(x.album.year) || 0) ||
        x.album.title.localeCompare(y.album.title),
    );

  const quiet = rows
    .filter((r) => r.plays > 0 && r.lastAt > 0 && r.lastAt < now - REDISCOVER_QUIET_DAYS * DAY)
    .sort((x, y) => x.lastAt - y.lastAt);

  const byName = (x: ShelfAlbum, y: ShelfAlbum): number =>
    nameSortKey(x.album.artist ?? "￿").localeCompare(nameSortKey(y.album.artist ?? "￿")) ||
    x.album.title.localeCompare(y.album.title);
  const neverPlayed = rows.filter((r) => r.plays === 0).sort(byName);

  return { unfinished, moreFrom, quiet, neverPlayed };
}
