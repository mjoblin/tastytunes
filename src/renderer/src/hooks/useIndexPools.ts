import { useEffect, useMemo, useState } from "react";
import type { MediaIndexPools } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";

/**
 * The ready indexes' pools, cached on their builtAt signature: re-entry is
 * instant, a rebuild (new signature) refetches, and every caller in a window
 * shares ONE snapshot. Lived inside LibraryScreen until the queue rows needed
 * the same thing (2026-08-21, performers for compilation entries) — a second
 * surface asks where the app already computes a thing, not how to compute it.
 *
 * `enabled` defers the fetch until a surface actually needs the pools (the
 * Library fetches when a lens opens); the last snapshot stays available
 * either way.
 *
 * WHEN THE POOLS EXIST: a stored index is ready at boot, so every window has
 * its pools from the first paint; on a fresh install nothing builds until
 * the Library or Search first lists servers (the mediaServers IPC kicks
 * ensureFresh), so a surface that only READS pools — the queue rows — shows
 * the device's strings until then. That is the index's law, not this hook's.
 */
let poolsCache: { sig: string; pools: MediaIndexPools[] } | null = null;
/** The one fetch on its way for a signature: every caller mounted while it is out waits on it.
 *  Without it each queue row (each a caller) fetched and kept its own copy of the whole index, a
 *  long queue opened first after a launch freezing the window for seconds and holding hundreds of
 *  megabytes, past the window's heap at the index's bound. */
let poolsFetch: { sig: string; promise: Promise<MediaIndexPools[]> } | null = null;

/** The pools for `sig`: the snapshot held, the fetch on its way, or one fetch for every caller. */
function poolsFor(sig: string): Promise<MediaIndexPools[]> {
  if (poolsCache?.sig === sig) return Promise.resolve(poolsCache.pools);
  if (poolsFetch?.sig === sig) return poolsFetch.promise;
  const promise = tt.mediaIndexPools().then(
    (pools) => {
      if (poolsFetch?.promise === promise) poolsFetch = null;
      poolsCache = { sig, pools };
      return pools;
    },
    (e: unknown) => {
      if (poolsFetch?.promise === promise) poolsFetch = null;
      throw e;
    },
  );
  poolsFetch = { sig, promise };
  return promise;
}

/** The ready indexes and when each was built, as one string: it changes when an index finishes
 *  building or starts a rebuild, or its server's Recently added list is read again (0.13.0). The
 *  pools below refetch on it, and the playing file asks for itself again on it while it has not
 *  been found (usePlayingFileRef). */
export function useReadyIndexSig(): string {
  const statuses = useStore((s) => s.mediaIndex);
  return useMemo(
    () =>
      statuses
        .filter((x) => x.state === "ready")
        .map((x) => `${x.udn}:${x.builtAt}:${x.recentAt ?? ""}`)
        .sort()
        .join("|"),
    [statuses],
  );
}

/** The last pools snapshot this window read, if any: for a reader outside React that can do
 *  without (a heart's other copies, lib/favorites). */
export const cachedPools = (): MediaIndexPools[] | null => poolsCache?.pools ?? null;

export function useIndexPools(enabled = true): MediaIndexPools[] | null {
  const sig = useReadyIndexSig();
  const [pools, setPools] = useState<MediaIndexPools[] | null>(() =>
    poolsCache?.sig === sig ? poolsCache.pools : null,
  );
  useEffect(() => {
    if (!enabled) return;
    if (poolsCache?.sig === sig) {
      setPools(poolsCache.pools);
      return;
    }
    let stale = false;
    poolsFor(sig)
      .then((fetched) => {
        if (!stale) setPools(fetched);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [enabled, sig]);
  return pools;
}
