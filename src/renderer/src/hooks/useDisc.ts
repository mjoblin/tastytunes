import { useEffect, useState } from "react";
import type { DiscTracks } from "@shared/model";
import {
  cdReleaseId,
  cdToc,
  isCdPlayback,
  type ZoneNowPlaying,
  type ZonePlayState,
  type ZoneState,
} from "@shared/smoip";
import { tt } from "@/api";
import { useStore } from "@/store";
import { activeSourceId, queuePlace } from "@/lib/format";

/** One track of the disc in the player: named when MusicBrainz or this session has named it. */
export interface DiscRow {
  n: number;
  title: string | null;
  secs: number | null;
}

export interface Disc {
  album: string | null;
  artist: string | null;
  artUrl: string | null;
  /** Every track, 1 to the disc's count; empty until the streamer has said how many. */
  rows: DiscRow[];
  /** The disc's length: its table of contents', else the named tracks' sum when all are known. */
  secs: number | null;
  /** The track under the head, 0-based; null while the disc is stopped. */
  head: number | null;
  /** Where the names came from: the disc's release on MusicBrainz, the streamer's own line as
   *  each track played this session, or nowhere yet. */
  names: "musicbrainz" | "session" | "none";
  /** A MusicBrainz lookup is on its way. */
  looking: boolean;
  /** The lookups are switched off (Settings, Artist and album info). */
  lookupsOff: boolean;
}

// THIS SESSION'S MEMORY of each disc, keyed by its release (or its artist and album): the table
// of contents the streamer titles a stopped disc with, which it drops once the disc plays, and
// the track names and lengths it gave as each track played. Answers from MusicBrainz are kept
// here too so a screen that remounts does not ask again (a miss is asked again: the main
// process caches the definitive ones, and a transient one deserves the retry).
const tocs = new Map<string, { tracks: number; secs: number }>();
const heard = new Map<string, Map<number, { title: string; secs: number | null }>>();
const found = new Map<string, DiscTracks>();

const discKey = (releaseId: string | null, artist: string | null, album: string | null) =>
  releaseId ?? (album ? `${artist ?? ""}|${album}`.toLowerCase() : null);

type Feeds = {
  playState: ZonePlayState | null;
  nowPlaying: ZoneNowPlaying | null;
  zoneState: ZoneState | null;
};

/** What the feeds say about the disc, its remembered table of contents included: the one
 *  reading useDisc and the navigation panel's count share. Null while the CD is not the
 *  source. */
function readDisc({ playState, nowPlaying, zoneState }: Feeds) {
  const md = playState?.metadata ?? null;
  const display = nowPlaying?.display ?? null;
  if (!isCdPlayback(md, display) && activeSourceId(zoneState, nowPlaying) !== "CD") return null;
  const album = md?.album ?? display?.line3 ?? null;
  const artist = md?.artist ?? display?.line2 ?? null;
  const artUrl = md?.art_url ?? display?.art_url ?? null;
  const releaseId = cdReleaseId(artUrl);
  const key = discKey(releaseId, artist, album);
  const tocNow = cdToc(md?.title);
  const toc = tocNow ?? (key ? tocs.get(key) : undefined) ?? null;
  const place = queuePlace(playState, nowPlaying);
  const count = toc?.tracks ?? place?.length ?? null;
  return { md, display, album, artist, artUrl, releaseId, key, tocNow, toc, place, count };
}

/** The disc's track count for the navigation panel's "CD 10": undefined while the CD is not
 *  the source, null while it is and the streamer has not said how many. */
export const useDiscCount = (): number | null | undefined =>
  useStore((s) => {
    const disc = readDisc(s);
    return disc ? disc.count : undefined;
  });

/**
 * The disc in the player (0.10.0, the CD), or null when the CD is not the source. The streamer
 * never lists a disc's tracks: it says how many there are (the table of contents while stopped,
 * now_playing's queue while playing) and names the one playing, so the list is the count, named
 * from MusicBrainz by the release the disc's cover came from, else by what the streamer said
 * as each track played this session, else by number.
 */
export function useDisc(): Disc | null {
  const playState = useStore((s) => s.playState);
  const nowPlaying = useStore((s) => s.nowPlaying);
  const zoneState = useStore((s) => s.zoneState);
  const lookups = useStore((s) => s.settings.artistInfo);
  const [settled, setSettled] = useState<string | null>(null);

  const disc = readDisc({ playState, nowPlaying, zoneState });
  const md = disc?.md ?? null;
  const display = disc?.display ?? null;
  const releaseId = disc?.releaseId ?? null;
  const key = disc?.key ?? null;
  const tocNow = disc?.tocNow ?? null;
  const toc = disc?.toc ?? null;
  const place = disc?.place ?? null;
  const count = disc?.count ?? null;
  const current = place && playState?.state !== "stop" ? place.index : null;
  const line1 = display?.line1 && !cdToc(display.line1) ? display.line1 : null;
  const lineSecs = display?.progress?.duration ?? md?.duration ?? null;

  // remember what the streamer says while it says it
  const tocTracks = tocNow?.tracks ?? null;
  const tocLength = tocNow?.secs ?? null;
  useEffect(() => {
    if (key && tocTracks != null && tocLength != null) {
      tocs.set(key, { tracks: tocTracks, secs: tocLength });
    }
  }, [key, tocTracks, tocLength]);
  useEffect(() => {
    if (!key || current == null || !line1) return;
    let names = heard.get(key);
    if (!names) heard.set(key, (names = new Map<number, { title: string; secs: number | null }>()));
    names.set(current + 1, { title: line1, secs: lineSecs });
  }, [key, current, line1, lineSecs]);

  const tocSecs = toc?.secs ?? null;
  const lookupKey = releaseId && lookups ? `${releaseId}|${count ?? ""}|${tocSecs ?? ""}` : null;
  useEffect(() => {
    if (!lookupKey || !releaseId || found.has(lookupKey)) return;
    let live = true;
    const settle = (got: DiscTracks | null): void => {
      if (got) found.set(lookupKey, got);
      if (live) setSettled(lookupKey);
    };
    tt.fetchDiscTracks(releaseId, count, tocSecs).then(settle, () => settle(null));
    return () => {
      live = false;
    };
  }, [lookupKey, releaseId, count, tocSecs]);

  if (!disc) return null;
  const mb = lookupKey ? found.get(lookupKey) : undefined;
  const learned = key ? heard.get(key) : undefined;
  const rows: DiscRow[] = Array.from({ length: count ?? mb?.tracks.length ?? 0 }, (_, i) => {
    const t = mb?.tracks[i];
    const now = current === i ? { title: line1, secs: lineSecs } : null;
    const then = learned?.get(i + 1);
    return {
      n: i + 1,
      title: t?.title ?? now?.title ?? then?.title ?? null,
      secs: t?.secs ?? now?.secs ?? then?.secs ?? null,
    };
  });
  const sum = rows.length > 0 && rows.every((r) => r.secs != null);
  return {
    album: disc.album,
    artist: disc.artist,
    artUrl: disc.artUrl,
    rows,
    secs: toc?.secs ?? (sum ? rows.reduce((s, r) => s + (r.secs ?? 0), 0) : null),
    head: current,
    names: mb ? "musicbrainz" : rows.some((r) => r.title != null) ? "session" : "none",
    looking: lookupKey != null && !mb && settled !== lookupKey,
    lookupsOff: !lookups,
  };
}
