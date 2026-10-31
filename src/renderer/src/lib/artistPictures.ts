import { useEffect, useSyncExternalStore } from "react";
import type { ChosenPicture, MediaNode } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { useReadyIndexSig } from "@/hooks/useIndexPools";
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

/** Main knows more now (the artist page's lookup found a photo, a picture was chosen or reset):
 *  every row showing the artist asks again, and takes main's answer (a real server picture still
 *  outranks the photo), and the window's chosen pictures are read again. */
export function refreshArtistPicture(name: string): void {
  cache.delete(keyOf(name));
  emit();
  loadArtistChoices();
}

// ------------------------------------------------------------------ chosen pictures

/** A cover the chooser offers: an album's picture, and which album it is (a choice keeps the
 *  album, so a cover whose address moves is found again). */
export interface CoverOffer {
  url: string;
  album: string;
  serverUdn: string | null;
}

/** The covers of an artist's albums, each picture once. */
export const coverOffers = (albums: readonly MediaNode[]): CoverOffer[] =>
  albums
    .filter((a, i) => a.artUrl && albums.findIndex((b) => b.artUrl === a.artUrl) === i)
    .map((a) => ({ url: a.artUrl as string, album: a.title, serverUdn: a.serverUdn ?? null }));

/**
 * THE CHOSEN PICTURES, one map for the window (0.13.0 rc.3, his pick: "Choose a picture" in the
 * artist's menu everywhere): read whole from main, so a menu built anywhere knows at once whether
 * an artist has one, as a heart knows from the favorites. Read again when a picture is chosen or
 * reset here (refreshArtistPicture), when the artist lookups are switched (a Wikipedia image
 * waits for them), and when an index is built (a cover is found again by its album). A read that
 * fails keeps the last map.
 */
let choicesAsked = 0;
export function loadArtistChoices(): void {
  const n = ++choicesAsked;
  const { setArtistChoices } = useStore.getState();
  void tt.artistChoices().then(
    (m) => {
      if (n === choicesAsked) setArtistChoices(m);
    },
    () => {
      if (n === choicesAsked && useStore.getState().artistChoices == null) setArtistChoices({});
    },
  );
}

/** Keeps the window's map current; App mounts it once. */
export function useArtistChoicesKept(): void {
  const lookups = useStore((s) => s.settings.artistInfo);
  const sig = useReadyIndexSig();
  useEffect(() => {
    loadArtistChoices();
  }, [lookups, sig]);
}

/** The picture chosen for an artist as the map has it now, for a menu built outside React. */
export const artistChoiceNow = (name: string): ChosenPicture | null =>
  useStore.getState().artistChoices?.[keyOf(name)] ?? null;

/** The picture chosen for an artist: undefined until the map is first read, null for none. A
 *  read again keeps the last answer until the new one lands. */
export function useArtistChoice(name: string): ChosenPicture | null | undefined {
  const k = keyOf(name);
  return useStore((s) => (s.artistChoices ? (s.artistChoices[k] ?? null) : undefined));
}

/** Clear an artist's chosen picture: the usual one comes back. */
export function resetArtistPicture(name: string): void {
  void tt
    .setArtistChoice(name, null)
    .then(() => refreshArtistPicture(name))
    .catch(() => {});
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
