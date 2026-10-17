import {
  albumDr14,
  albumDrKey,
  audioAnalysisKey,
  integrateLoudnessHistograms,
  trackInAlbumOf,
  type AlbumDr,
  type MediaIndexPools,
  type MediaNode,
} from "@shared/model";

/** What the album check reads: the recorded album values and each track's measured DR. */
export interface AlbumDrSources {
  /** The album DRs already recorded, by album key. */
  recorded: ReadonlyMap<string, AlbumDr>;
  /** A track's measured DR by its content key; undefined when it has not been analysed. */
  dr(trackKey: string): number | undefined;
  /** A track's loudness histogram, read only for an album found complete. */
  hist(trackKey: string): readonly number[] | null | undefined;
}

const lc = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();

/**
 * AN ALBUM'S DR FROM ITS TRACKS (user, 2026-10-12, after an album page showed no DR for an
 * album nine-tenths measured by play: "i thought we already did that? we should if we're not
 * already"). The album value used to be written by the album sweep alone, so tracks measured
 * one at a time as they played (or by the Tracks lens's Analyze audio) never added up to an
 * album. Every album in the ready indexes whose every track is measured gets the sweep's own
 * number: albumDr14 of the track DRs (the reference's mean of every track, a DR0 interlude
 * included), and the loudness integrated across their histograms when every track carries
 * one. An album already recorded at its track count is left as it is; one recorded at another
 * count (tracks added or removed) is recorded again. Same-keyed albums in one library (twin
 * editions, the Evo drive's two folders of one album) are left to an explicit sweep: the
 * album key cannot tell them apart. An album with no artist is left too (its tracks cannot be
 * told from a same-titled album's). With `onlyTrackKey`, only the album holding that track.
 */
export function albumDrsFromTracks(
  pools: readonly MediaIndexPools[],
  src: AlbumDrSources,
  onlyTrackKey?: string,
  now = Date.now(),
): { key: string; entry: AlbumDr }[] {
  const out: { key: string; entry: AlbumDr }[] = [];
  const done = new Set<string>();
  for (const pool of pools) {
    const byKey = new Map<string, MediaNode[]>();
    for (const a of pool.albums) {
      const k = albumDrKey(a);
      byKey.set(k, [...(byKey.get(k) ?? []), a]);
    }
    const byTitle = new Map<string, MediaNode[]>();
    for (const t of pool.tracks) {
      if (!t.album) continue;
      const k = lc(t.album);
      byTitle.set(k, [...(byTitle.get(k) ?? []), t]);
    }
    for (const [key, same] of byKey) {
      if (same.length !== 1 || done.has(key)) continue;
      const album = same[0];
      if (!album.artist) continue;
      const own = (byTitle.get(lc(album.title)) ?? []).filter((t) =>
        trackInAlbumOf(t, album.artist),
      );
      if (own.length === 0) continue;
      const keys = own.map((t) => audioAnalysisKey(t));
      if (onlyTrackKey != null && !keys.includes(onlyTrackKey)) continue;
      if (src.recorded.get(key)?.tracks === own.length) continue;
      const drs: number[] = [];
      for (const k of keys) {
        const dr = src.dr(k);
        if (dr == null) break;
        drs.push(dr);
      }
      if (drs.length !== keys.length) continue;
      const hists: (readonly number[])[] = [];
      for (const k of keys) {
        const h = src.hist(k);
        if (h) hists.push(h);
      }
      const lufs = hists.length === keys.length ? integrateLoudnessHistograms(hists) : null;
      out.push({ key, entry: { dr: albumDr14(drs), tracks: own.length, analyzedAt: now, lufs } });
      done.add(key);
    }
  }
  return out;
}
