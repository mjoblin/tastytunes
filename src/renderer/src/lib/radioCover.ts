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
 * station's name. The logo is shown while the song is asked, between songs, and whenever no
 * cover matches. Off with Settings › Appearance › Song covers on radio, or with Missing album
 * art off (no request goes out).
 *
 * ONE HOME: each big surface passes what its best-art rule chose (lib/bestArt) through
 * useRadioCover, so the radio's step sits on top of that rule rather than inside it.
 */

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
  };
}

const memory = stationArtMemory();

/** Each song's cover once found, so the surfaces that ask about one song ask main once; a song
 *  with none is asked again when it next plays (main remembers its settled misses). */
const found = new Lru<string, Promise<string | null>>(40);

function ask(artist: string, song: string): Promise<string | null> {
  const key = `${artist}|${song}`;
  let p = found.get(key);
  if (!p) {
    p = tt.radioCover(artist, song).catch(() => null);
    found.set(key, p);
    void p.then((url) => {
      if (url == null) found.delete(key);
    });
  }
  return p;
}

/** The picture a big surface shows: the song's cover while a station plays a song that has one,
 *  else `art` as its best-art rule chose it. `meta` null asks nothing (a wash with nothing up). */
export function useRadioCover(meta: NowPlayingMeta | null, art: string | null): string | null {
  const wanted = useStore((s) => s.settings.radioCovers && s.settings.albumArtLookup);
  const song = radioSongOf(meta);
  const station = meta?.title ?? null;
  const logo = meta?.artUrl ?? null;
  const asking = wanted && song && station ? `${station}␟${song.artist}␟${song.song}` : null;
  const [cover, setCover] = useState<{ for: string; url: string } | null>(null);
  const lookUp = useEffectEvent(() => {
    if (!asking || !song || !station) return;
    if (memory.note(station, `${song.artist}␟${song.song}`, logo)) return;
    let live = true;
    void ask(song.artist, song.song).then((url) => {
      if (live && url) setCover({ for: asking, url });
    });
    return () => {
      live = false;
    };
  });
  useEffect(() => lookUp(), [asking]);
  // a new song shows the station's picture until its own cover is found
  return cover && cover.for === asking ? cover.url : art;
}
