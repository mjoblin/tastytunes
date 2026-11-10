import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
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
  // a landed lookup re-renders, and the render reads the cache afresh (keys alone never change
  // across a landing)
  const [, bump] = useState(0);
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
  // what to ask for: the keys with no answer, or a stale one, not already asked. The cache is module
  // state, so this is read each render and the ask runs when the list's content changes (0.15.0:
  // before, a memo keyed on a landing counter it never read)
  const missing = keys.filter((k) => (!cache.has(k) || stale.has(k)) && !inFlight.has(k));
  const missingKey = missing.join("\u0000");
  const ask = useEffectEvent(() => {
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
  });
  useEffect(() => ask(), [missingKey]);
  // the pictures found, read from the cache each render and handed out as one object while they
  // stay the same, so a render between landings changes nothing downstream
  const found = keys.map((k) => cache.get(k) ?? "").join("\u0000");
  return useMemo(() => {
    const out: Record<string, string | null> = {};
    found.split("\u0000").forEach((v, i) => {
      if (v) out[keys[i]] = v;
    });
    return out;
  }, [keys, found]);
}
