import { useEffect, useState, useEffectEvent } from "react";
import { splitRadioTitle } from "@shared/elsewhere";
import { tt } from "@/api";
import { useStore } from "@/store";
import { Lru } from "@/lib/lru";
import type { NowPlayingMeta } from "@/lib/format";

/**
 * SONG COVERS ON RADIO (0.17.0): a station's big picture is its song's own cover. A station
 * announces its song as one "Artist - Song" title and sends its logo as the picture, whatever
 * plays; on the BIG surfaces (the Now Playing hero, Display mode and a page on another screen,
 * the wash) the song's cover takes the logo's place once main finds it (lookups/radioCover).
 * The small ones (the bar, the mini player, the tray) never ask, and keep the logo beside the
 * station's name. Off with Settings › Appearance › Song covers on radio, or with Missing album
 * art off (no request goes out).
 *
 * NO LOGO FOR A MOMENT: the last song's cover stays while the next one's is asked (at most
 * HOLD_MS), and through a gap in the station's text (a frame without the song, at most GAP_MS), so
 * a song change goes cover to cover; the logo shows on a miss, between songs that stay unnamed,
 * on a station's first song until its cover comes, and at once for another station (another logo).
 * A song's answer is kept by its artist and title, so a song asked once shows its cover at once.
 *
 * ONE HOME: each big surface passes what its best-art rule chose (lib/bestArt) through
 * useRadioCover, so the radio's step sits on top of that rule rather than inside it.
 */

/** How long the last cover is kept while the next song's is asked. */
export const HOLD_MS = 6_000;
/** How long the last cover is kept while the station names no song. */
export const GAP_MS = 3_000;
/** How long a song with no cover is taken at its word: a miss may have been a failed ask. */
const MISS_MS = 5 * 60_000;

/** The song a station announces, as artist and song; null off the radio, or when its title
 *  doesn't split into both (a show's name, the station's own message). */
export function radioSongOf(
  meta: Pick<NowPlayingMeta, "isRadio" | "subtitle"> | null,
): { artist: string; song: string } | null {
  if (!meta?.isRadio || !meta.subtitle) return null;
  const { artist, song } = splitRadioTitle(meta.subtitle, null);
  return artist && song ? { artist, song } : null;
}

/**
 * STATIONS THAT SEND THEIR OWN SONG PICTURES keep them: a station whose picture changed when its
 * song did sends a picture per song, so its pictures stand and nothing is asked for it again this
 * session. Kept apart from the hook so it can be tested.
 */
export function stationArtMemory(): {
  note(station: string, song: string, art: string | null): boolean;
  sends(station: string): boolean;
} {
  const own = new Set<string>();
  const last = new Map<string, { song: string; art: string | null }>();
  return {
    /** Notes the station's picture for its song; whether the station sends its own pictures. */
    note(station, song, art) {
      const prev = last.get(station);
      if (prev && prev.song !== song && prev.art && art && prev.art !== art) own.add(station);
      last.set(station, { song, art });
      return own.has(station);
    },
    /** Whether the station is known to send its own pictures. */
    sends: (station) => own.has(station),
  };
}

const memory = stationArtMemory();

/** Each song's answer, by artist and title: its cover, or null for none (taken for MISS_MS). */
const answers = new Lru<string, { url: string | null; at: number }>(60);
const asking = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function answerOf(key: string): string | null | undefined {
  const a = answers.peek(key);
  if (!a) return undefined;
  if (a.url == null && Date.now() - a.at > MISS_MS) return undefined;
  return a.url;
}

function ask(key: string, artist: string, song: string): void {
  if (asking.has(key) || answerOf(key) !== undefined) return;
  const p = tt
    .radioCover(artist, song)
    .catch(() => null)
    .then((url) => {
      answers.set(key, { url, at: Date.now() });
      asking.delete(key);
      for (const heard of listeners) heard();
    });
  asking.set(key, p);
}

/** The picture a big surface shows: the song's cover while a station plays a song that has one,
 *  else `art` as its best-art rule chose it. `meta` null asks nothing (a wash with nothing up). */
export function useRadioCover(meta: NowPlayingMeta | null, art: string | null): string | null {
  const wanted = useStore((s) => s.settings.radioCovers && s.settings.albumArtLookup);
  const [, heard] = useState(0);
  useEffect(() => {
    const on = (): void => heard((n) => n + 1);
    listeners.add(on);
    return () => void listeners.delete(on);
  }, []);
  const radio = wanted && meta?.isRadio === true;
  const song = radio ? radioSongOf(meta) : null;
  const station = meta?.title ?? null;
  // the station's own picture stands for the station: another logo is another station
  const logo = radio ? (meta?.artUrl ?? null) : null;
  const key = song ? `${song.artist}␟${song.song}` : null;
  const answer = key ? answerOf(key) : undefined;
  const own = station != null && memory.sends(station);

  const lookUp = useEffectEvent(() => {
    if (!key || !song || !station) return;
    if (memory.note(station, key, logo)) heard((n) => n + 1);
    else ask(key, song.artist, song.song);
  });
  useEffect(() => lookUp(), [key]);

  // the last cover shown here, kept over a change or a gap while it is the same station's
  const [held, setHeld] = useState<{ logo: string | null; url: string } | null>(null);
  useEffect(() => {
    if (answer) setHeld({ logo, url: answer });
    // a song with no cover shows the logo, and the next song starts from it
    else if (answer === null || !radio) setHeld(null);
  }, [answer, logo, radio]);
  const holding = held != null && radio && !own && held.logo === logo && answer === undefined;
  useEffect(() => {
    if (!holding) return;
    const t = setTimeout(() => setHeld(null), key ? HOLD_MS : GAP_MS);
    return () => clearTimeout(t);
  }, [holding, key]);

  if (!radio || own) return art;
  if (answer) return answer;
  if (holding) return held.url;
  return art;
}
