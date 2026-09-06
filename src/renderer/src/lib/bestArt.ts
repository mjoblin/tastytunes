import { useEffect, useState } from "react";
import type { EmbeddedArt, EmbeddedArtQuery } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";

/**
 * The best artwork for a BIG surface (the Now Playing hero, Display mode, the
 * ambient wash, the album header): the server's art unless it is missing or
 * small, in which case the picture embedded in the audio file, when the file
 * has one and it is larger. Rows and cards never ask; their thumbs are fine.
 * ONE home for the rule; each surface hands in its server URL and the track
 * to read and gets a URL back. Off with Settings › Appearance › Album art
 * from audio files.
 */
const SMALL_PX = 600;
const pending = new Map<string, Promise<EmbeddedArt | null>>();

function embedded(query: EmbeddedArtQuery): Promise<EmbeddedArt | null> {
  const key = JSON.stringify(query);
  let p = pending.get(key);
  if (!p) {
    p = tt.embeddedArt(query).catch(() => null);
    pending.set(key, p);
  }
  return p;
}

function naturalWidth(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth || null);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export function useBestArt(
  serverUrl: string | null | undefined,
  query: EmbeddedArtQuery | null,
): string | null {
  const enabled = useStore((s) => s.settings.artFromFiles);
  const [best, setBest] = useState<string | null>(serverUrl ?? null);
  const queryKey = query ? JSON.stringify(query) : null;
  useEffect(() => {
    setBest(serverUrl ?? null);
    if (!enabled || !query) return;
    let live = true;
    void (async () => {
      const serverWidth = serverUrl ? await naturalWidth(serverUrl) : null;
      if (!live) return;
      // the server's art is big enough: keep it, ask nothing
      if (serverWidth != null && serverWidth >= SMALL_PX) return;
      const art = await embedded(query);
      if (!live || !art) return;
      if (serverWidth == null || art.width > serverWidth) setBest(art.dataUrl);
    })();
    return () => {
      live = false;
    };
    // queryKey stands for query (a fresh object every render)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUrl, queryKey, enabled]);
  return best;
}
