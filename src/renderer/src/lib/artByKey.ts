import { useEffect, useMemo, useRef, useState } from "react";
import { tt } from "@/api";
import { useStore } from "@/store";
import { Lru } from "@/lib/lru";

/**
 * Art for content keys (playKey) from the library index, for surfaces whose
 * data carries none — the History Timeline's rows (the record stores no art;
 * the index knows the track). One module cache for the session: a key asked
 * once is never asked again (a miss caches as null), and a render passes only
 * the keys on screen, so a windowed list costs one small IPC per slice.
 */
const cache = new Lru<string, string | null>(5000);
let inFlight: Set<string> = new Set();
/** Found pictures from before the index last changed: still shown, and asked again (a wake
 *  re-mints a USB drive's picture addresses and the heal moves the index's, 2026-10-11; a hit
 *  kept for the session went dead with them). */
const stale = new Set<string>();
/** The index status the cache last answered from (module-wide: one change, one re-ask). */
let seenIndex: string | null = null;

export function useArtByKeys(keys: readonly string[]): Record<string, string | null> {
  // gen counts landed lookups: the result memo and the missing list re-read
  // the cache on each landing (keys alone never change across a landing)
  const [gen, bump] = useState(0);
  // re-render when a lookup lands, as long as the component is still mounted
  // (a per-effect stale flag would swallow the landing whenever the list
  // re-rendered mid-flight, and the art would wait for an unrelated render)
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // a miss is only as good as the index that answered it: when the index's
  // status changes (a crawl finishing, a rescan), cached misses are forgotten
  const indexSig = useStore((s) => JSON.stringify(s.mediaIndex));
  useEffect(() => {
    for (const [k, v] of cache) if (v == null) cache.delete(k);
    // a found picture is asked again once the index itself has changed (not on every mount)
    if (seenIndex === indexSig) return;
    const changed = seenIndex != null;
    seenIndex = indexSig;
    if (!changed) return;
    for (const [k] of cache) stale.add(k);
    bump((n) => n + 1);
  }, [indexSig]);
  const missing = useMemo(
    () => keys.filter((k) => (!cache.has(k) || stale.has(k)) && !inFlight.has(k)),
    // gen and indexSig re-read the cache; they are not read directly
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keys, gen, indexSig],
  );
  useEffect(() => {
    if (missing.length === 0) return;
    inFlight = new Set([...inFlight, ...missing]);
    void tt
      .libraryArtByKeys(missing)
      .then((m) => {
        for (const k of missing) {
          // a re-ask that finds nothing keeps the picture it had (a miss is no evidence the
          // old one died); a fresh answer replaces it
          if (m[k] != null || !stale.has(k)) cache.set(k, m[k] ?? null);
          stale.delete(k);
        }
      })
      .catch(() => {
        for (const k of missing) {
          if (!stale.has(k)) cache.set(k, null);
          stale.delete(k);
        }
      })
      .finally(() => {
        for (const k of missing) inFlight.delete(k);
        if (mounted.current) bump((n) => n + 1);
      });
  }, [missing]);
  return useMemo(() => {
    const out: Record<string, string | null> = {};
    for (const k of keys) {
      const v = cache.get(k);
      if (v != null) out[k] = v;
    }
    return out;
    // the cache is module state; gen marks each landing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, gen]);
}
