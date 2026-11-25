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

/** The address behind a drawn picture: a thumbnail's own (tt-art's `u`), else as it is. */
const addressOf = (src: string | null | undefined): string | null => {
  if (!src) return null;
  if (!src.startsWith("tt-art://")) return src;
  try {
    return new URL(src).searchParams.get("u");
  } catch {
    return null;
  }
};

function lookup(artist: string, album: string, failed: string | null): Promise<string | null> {
  const key = `${artist.toLowerCase()}|${album.toLowerCase()}|${failed ?? ""}`;
  let p = memo.get(key);
  if (!p) {
    // another library's cover is an address: drawn through the thumbnail cache, as the
    // album's own would be (the Cover Art Archive's answer is already a data URL); the
    // album's own failed address is named, so it is never offered back
    p = tt
      .albumArt(artist, album, failed)
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
  failedSrc: string | null = null,
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const artist = ask?.artist ?? null;
  const album = ask?.album ?? null;
  const failed = addressOf(failedSrc);
  useEffect(() => {
    setUrl(null);
    if (!enabled || !artist || !album) return;
    let live = true;
    void lookup(artist, album, failed).then((u) => {
      if (live && u) setUrl(u);
    });
    return () => {
      live = false;
    };
  }, [artist, album, enabled, failed]);
  return url;
}
