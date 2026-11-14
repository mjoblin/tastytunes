import { useEffect, useState } from "react";
import { tt } from "@/api";
import { Lru } from "@/lib/lru";
import { artSrc } from "@/lib/artSrc";

/**
 * An album's cover when its own is missing or failed, renderer side: main answers with the same
 * album's cover from another library (0.16.0), else the Cover Art Archive's. One in-flight promise
 * per artist|album so a grid of the same artless album asks main exactly once, and misses are
 * remembered for the session (main's disk cache remembers the archive's across sessions,
 * including definitive misses).
 */
const memo = new Lru<string, Promise<string | null>>(500);

function lookup(artist: string, album: string): Promise<string | null> {
  const key = `${artist.toLowerCase()}|${album.toLowerCase()}`;
  let p = memo.get(key);
  if (!p) {
    // another library's cover is an address: drawn through the thumbnail cache, as the
    // album's own would be (the Cover Art Archive's answer is already a data URL)
    p = tt
      .albumArt(artist, album)
      .then((u) => (u && /^https?:/i.test(u) ? artSrc(u, 240) : u))
      .catch(() => null);
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
