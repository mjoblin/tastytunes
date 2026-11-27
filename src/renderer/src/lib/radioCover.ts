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
 * and at once for another station (another logo). With no cover to hold (a fresh start, another
 * station) the surface shows no picture while the first answer comes (at most FIRST_MS, `waiting`)
 * rather than the logo for a moment. A song's answer is kept by its artist and title, so a song
 * asked once shows its cover at once; a song with none is asked again (RETRY_MS, TRIES), since a
 * failed ask (MusicBrainz busy, the archive slow) answers none too, and main keeps the songs that
 * truly have none, so asking those again costs nothing.
 *
 * ONE HOME: each big surface passes what its best-art rule chose (lib/bestArt) through
 * useRadioCover, so the radio's step sits on top of that rule rather than inside it.
 */

/** How long the last cover is kept while the next song's is asked. */
export const HOLD_MS = 6_000;
/** How long the last cover is kept while the station names no song. */
export const GAP_MS = 3_000;
/** How long a surface with no cover to hold shows no picture while the first answer comes. */
export const FIRST_MS = 2_500;
/** A song with no cover is asked again after this long, at most TRIES times in all while it plays. */
export const RETRY_MS = 20_000;
export const TRIES = 3;
/** How long a song with no cover is taken at its word, past its tries: it may play again later. */
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
 * STATIONS THAT SEND THEIR OWN SONG PICTURES keep them: a station that has shown three different
 * pictures across its songs sends a picture per song, so its pictures stand and nothing is asked
 * for it again this session. Three, so its logo and one stray picture (a first frame, an ad's)
 * never turn its covers off. Kept apart from the hook so it can be tested.
 */
export function stationArtMemory(): {
  note(station: string, song: string, art: string | null): boolean;
  sends(station: string): boolean;
} {
  const own = new Set<string>();
  const last = new Map<string, string>();
  const seen = new Map<string, Set<string>>();
  return {
    /** Notes the station's picture for a song; whether the station sends its own pictures. */
    note(station, song, art) {
      if (last.get(station) === song) return own.has(station);
      last.set(station, song);
      const pictures = seen.get(station) ?? new Set<string>();
      if (art) pictures.add(art);
      seen.set(station, pictures);
      if (pictures.size >= 3) own.add(station);
      return own.has(station);
    },
    /** Whether the station is known to send its own pictures. */
    sends: (station) => own.has(station),
  };
}

const memory = stationArtMemory();

/** Each song's answer, by artist and title: its cover, or null for none (asked again up to TRIES
 *  times, then taken for MISS_MS), with the asks it took. */
const answers = new Lru<string, { url: string | null; at: number; tries: number }>(60);
const asking = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

function answerOf(key: string): string | null | undefined {
  const a = answers.peek(key);
  if (!a) return undefined;
  if (a.url == null && Date.now() - a.at > MISS_MS) return undefined;
  return a.url;
}

/** The asks a song's answer has taken (none yet, or past MISS_MS: none). */
const triesOf = (key: string): number =>
  answerOf(key) === undefined ? 0 : (answers.peek(key)?.tries ?? 0);

function ask(key: string, artist: string, song: string): void {
  const answer = answerOf(key);
  if (asking.has(key) || answer || (answer === null && triesOf(key) >= TRIES)) return;
  const tries = triesOf(key) + 1;
  const p = tt
    .radioCover(artist, song)
    .catch(() => null)
    .then((url) => {
      answers.set(key, { url, at: Date.now(), tries });
      asking.delete(key);
      for (const heard of listeners) heard();
    });
  asking.set(key, p);
}

/** The picture a big surface shows: the song's cover while a station plays a song that has one,
 *  else `art` as its best-art rule chose it, and none while there is no cover to hold and the
 *  song's first answer is coming (FIRST_MS: an empty place, never the station's logo for a
 *  moment). `meta` null asks nothing (a wash with nothing up). */
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
  const tries = key ? triesOf(key) : 0;
  const own = station != null && memory.sends(station);

  const lookUp = useEffectEvent(() => {
    if (!key || !song || !station) return;
    if (memory.note(station, key, logo)) heard((n) => n + 1);
    else ask(key, song.artist, song.song);
  });
  useEffect(() => lookUp(), [key]);
  // a song with no cover asked again: a failed ask answers none too
  const askAgain = useEffectEvent(() => {
    if (key && song) ask(key, song.artist, song.song);
  });
  useEffect(() => {
    if (answer !== null || !key || tries >= TRIES) return;
    const t = setTimeout(askAgain, RETRY_MS);
    return () => clearTimeout(t);
  }, [answer, key, tries]);

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
  // with no cover to hold and nothing shown yet (a fresh start), no picture while the first answer
  // comes; a station whose logo this surface already shows keeps it until the cover comes, so a
  // song named after a station starts goes logo to cover, never through an empty place
  const [waited, setWaited] = useState<string | null>(null);
  useEffect(() => {
    if (!key) return;
    const t = setTimeout(() => setWaited(key), FIRST_MS);
    return () => clearTimeout(t);
  }, [key]);
  const [logoShown, setLogoShown] = useState<string | null>(null);

  let shown: string | null;
  if (!radio || own) shown = art;
  else if (answer) shown = answer;
  else if (holding) shown = held.url;
  else if (key != null && answer === undefined && waited !== key && logoShown !== logo)
    shown = null;
  else shown = logo;
  useEffect(() => {
    if (radio && logo != null && shown === logo) setLogoShown(logo);
  }, [radio, logo, shown]);
  return shown;
}

/** Whether a big surface's empty place stays quiet: while a station has a picture of its own, a
 *  moment without one is its song's first cover coming (useRadioCover), so the radio's placeholder
 *  never shows there, even for the frame the cover takes to decode. */
export const quietPlace = (meta: Pick<NowPlayingMeta, "isRadio" | "artUrl">): boolean =>
  meta.isRadio && meta.artUrl != null;
