import { useEffect, useState } from "react";
import { tt } from "@/api";

/**
 * Cover Art Archive fallback, renderer side: one in-flight promise per
 * artist|album so a grid of the same artless album asks main exactly once,
 * and misses are remembered for the session (main's disk cache remembers
 * across sessions, including definitive misses).
 */
const memo = new Map<string, Promise<string | null>>();

function lookup(artist: string, album: string): Promise<string | null> {
  const key = `${artist.toLowerCase()}|${album.toLowerCase()}`;
  let p = memo.get(key);
  if (!p) {
    p = tt.albumArt(artist, album).catch(() => null);
    memo.set(key, p);
  }
  return p;
}

/** Resolves to a data URL once known; null while pending or when there is no cover. */
export function useArtFallback(
  ask: { artist: string | null | undefined; album: string | null | undefined } | undefined,
  enabled: boolean,
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const artist = ask?.artist ?? null;
  const album = ask?.album ?? null;
  useEffect(() => {
    setUrl(null);
    if (!enabled || !artist || !album) return;
    let live = true;
    void lookup(artist, album).then((u) => {
      if (live && u) setUrl(u);
    });
    return () => {
      live = false;
    };
  }, [artist, album, enabled]);
  return url;
}
