import { useEffect, useSyncExternalStore } from "react";
import { tt } from "@/api";
import { useStore } from "@/store";
import { Lru } from "@/lib/lru";

/**
 * ARTIST PICTURES for rows and cards (0.11.0, a user's email: "Would it be possible for
 * TastyTunes to scrape artist image and display it instead of the grey square with disc
 * image? (Like Plexamp does)"). A row never looks an artist up (MusicBrainz answers one
 * request a second, and a library has hundreds of artists): every name asked for in one frame
 * goes to main in one artistPictures request, which answers a photo already known (the artist
 * page and About the artist look them up) or a cover from the artist's own albums, behind the
 * server's own picture when that is a real one (main tells them apart). Kept for the session; a
 * miss is asked again when the index changes, and a photo that lands on the artist page sends
 * every row back to main at once (refreshArtistPicture).
 */
const cache = new Lru<string, string | null>(3000);
const pending = new Map<string, string>();
const listeners = new Set<() => void>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** The index status the misses were answered from (module-wide: one change, one re-ask). */
let seenIndex: unknown = null;

const keyOf = (name: string): string => name.trim().toLowerCase();
const emit = (): void => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function flush(): void {
  flushTimer = null;
  const asked = [...pending.values()];
  pending.clear();
  if (asked.length === 0) return;
  void tt.artistPictures(asked).then(
    (m) => {
      for (const n of asked) cache.set(keyOf(n), m[n] ?? null);
      emit();
    },
    () => {
      for (const n of asked) cache.set(keyOf(n), null);
      emit();
    },
  );
}

function want(name: string): void {
  const k = keyOf(name);
  if (!k || cache.has(k) || pending.has(k)) return;
  pending.set(k, name);
  flushTimer ??= setTimeout(flush, 0);
}

/** Main knows more now (the artist page's lookup found a photo): every row showing the artist
 *  asks again, and takes main's answer (a real server picture still outranks the photo). */
export function refreshArtistPicture(name: string): void {
  cache.delete(keyOf(name));
  emit();
}

/** The picture for an artist row or card: a known photo, else an album cover, else null. */
export function useArtistPicture(name: string | null | undefined): string | null {
  return useArtistPictureAnswer(name) ?? null;
}

/** Main's answer as it stands: undefined while it is being asked (the artist page waits for
 *  it rather than drawing a picture it may replace a moment later), null for none. */
export function useArtistPictureAnswer(name: string | null | undefined): string | null | undefined {
  const k = name ? keyOf(name) : null;
  const mediaIndex = useStore((s) => s.mediaIndex);
  useEffect(() => {
    if (seenIndex === mediaIndex) return;
    const changed = seenIndex != null;
    seenIndex = mediaIndex;
    if (!changed) return;
    for (const [key, v] of cache) if (v == null) cache.delete(key);
    emit();
  }, [mediaIndex]);
  const value = useSyncExternalStore(subscribe, () => (k ? cache.get(k) : undefined));
  useEffect(() => {
    if (name && value === undefined) want(name);
  }, [name, value]);
  return value;
}
