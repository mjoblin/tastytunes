import type { MediaInfoQuery, MediaInfoTarget, MediaNode, StreamInfo } from "@shared/model";
import { isCdPlayback, type ZoneNowPlaying, type ZonePlayState } from "@shared/smoip";
import { tt } from "@/api";
import { useStore } from "@/store";
import type { MediaRef } from "@/lib/mediaRef";
import { deriveNowPlaying, queuePlace } from "@/lib/format";
import { queueSourceActive } from "@/hooks/useQueueSourceActive";
import {
  newInfoList,
  openInfoInList,
  pushInfo,
  refSiblings,
  replaceInfoInList,
} from "@/lib/infoSteps";
import { fromQueueItem } from "@/lib/mediaRef";

/** What a list knew about a ref, as an Info node: shown at once while the library is asked. */
function refStub(ref: MediaRef): MediaNode {
  return {
    id: ref.objectId ?? "",
    parentId: null,
    title: ref.title,
    upnpClass:
      ref.kind === "album"
        ? "object.container.album.musicAlbum"
        : ref.kind === "artist"
          ? "object.container.person.musicArtist"
          : "object.item.audioItem.musicTrack",
    isContainer: ref.kind !== "track",
    artUrl: ref.artUrl,
    artist: ref.artist,
    album: ref.album,
    year: null,
    trackNumber: null,
    durationSecs: ref.durationSecs,
    ...(ref.serverUdn ? { serverUdn: ref.serverUdn } : {}),
    ...(ref.serverName ? { serverName: ref.serverName } : {}),
  };
}

/** A ref's Info target: the library's node when main finds it (index by id, then by content,
 *  then live BrowseMetadata), else what the list knew, with a caveat. */
export async function lookupRefInfo(ref: MediaRef, stub = refStub(ref)): Promise<MediaInfoTarget> {
  const query: MediaInfoQuery = {
    kind: ref.kind === "station" ? "track" : ref.kind,
    title: ref.title,
    artist: ref.artist,
    album: ref.album,
    serverUdn: ref.serverUdn,
    objectId: ref.objectId,
  };
  let found = null;
  try {
    found = await tt.mediaNodeInfo(query, "show");
  } catch {
    found = null;
  }
  return found
    ? { ...found, serverName: found.serverName ?? ref.serverName ?? null }
    : {
        node: stub,
        serverName: ref.serverName ?? null,
        note: "Not found in any library index. Showing what this list knows.",
      };
}

/**
 * Open the Info modal for something a LIST holds only a ref to (a queue row,
 * favorite, playlist item, recent, search hit). Main looks the node up and the
 * modal shows everything found; when nothing is found it still opens on what
 * the list knew, with a caveat, rather than doing nothing. Stations have no
 * library node and are left to their own surfaces. Given the list the ref sits
 * in (its refs and the ref's place), the modal steps through it (lib/infoSteps).
 */
export async function openInfoForRef(
  ref: MediaRef,
  siblings?: { refs: readonly MediaRef[]; index: number },
  /** As a new page of the Info window's history (a track's album name), not in place. */
  { push = false }: { push?: boolean } = {},
): Promise<void> {
  if (ref.kind === "station") return;
  const set = useStore.getState().setMediaInfo;
  // open at once on what we have — the lookup usually lands within a beat and
  // simply enriches it (a click that does nothing while a live browse runs
  // reads as a dead menu item)
  const stub = refStub(ref);
  const opening: MediaInfoTarget = {
    node: stub,
    serverName: ref.serverName ?? null,
    note: "Looking it up in the library…",
  };
  const list =
    siblings && siblings.refs.length > 1 && siblings.refs[siblings.index] != null
      ? newInfoList(
          siblings.refs.map((r) => () => lookupRefInfo(r)),
          siblings.index,
        )
      : null;
  if (push) pushInfo(opening, list);
  else set(opening, list);
  const found = await lookupRefInfo(ref, stub);
  // only replace if the user hasn't closed (or opened something else) meanwhile
  const current = useStore.getState().mediaInfo;
  if (!current || current.node !== stub) return;
  if (list) replaceInfoInList(list, found);
  else set(found);
}

/**
 * The pure half of "info for what is playing now": the streamer's own account
 * of the stream plus a stub node, built synchronously from the pushes — and,
 * for local media, the content query that finds the library node. Shared by
 * the Info modal path below and the context drawer's Stream tab, so the two
 * surfaces can never derive the stream differently. Null when nothing is
 * loaded.
 */
export function nowPlayingInfoTarget(
  playState: ZonePlayState | null,
  nowPlaying: ZoneNowPlaying | null,
): { target: MediaInfoTarget; localQuery: MediaInfoQuery | null } | null {
  const md = playState?.metadata ?? null;
  const display = nowPlaying?.display ?? null;
  const klass = md?.class ?? display?.class ?? null;
  const isRadio = /radio/i.test(klass ?? "") || md?.station != null;
  // a disc's table of contents is no track's title: the one reading of a track's is
  // deriveNowPlaying's
  const title = isRadio
    ? (md?.title ?? display?.line2 ?? md?.station ?? display?.line1 ?? null)
    : deriveNowPlaying(playState, nowPlaying).title;
  if (!title && !md?.station) return null;
  const place = queuePlace(playState, nowPlaying);
  const stream: StreamInfo = {
    source: nowPlaying?.source?.name ?? md?.source ?? null,
    playbackSource: md?.playback_source ?? display?.playback_source ?? null,
    playbackClass: klass,
    codec: md?.codec ?? null,
    sampleFormat: md?.sample_format ?? display?.format ?? null,
    sampleRate: md?.sample_rate ?? null,
    bitDepth: md?.bit_depth ?? null,
    bitrate: md?.bitrate ?? null,
    encoding: md?.encoding ?? null,
    lossless: md?.lossless ?? null,
    mqa: md?.mqa && md.mqa !== "none" ? md.mqa : null,
    station: md?.station ?? (isRadio ? (display?.line1 ?? null) : null),
    radioId: md?.radio_id != null ? String(md.radio_id) : null,
    queuePosition: place ? place.index + 1 : null,
    queueLength: place?.length ?? null,
    presettable: playState?.presettable ?? null,
    controls: nowPlaying?.controls ?? [],
  };
  const artist = isRadio ? null : (md?.artist ?? display?.line2 ?? null);
  const album = isRadio ? null : (md?.album ?? display?.line3 ?? null);
  const stub: MediaNode = {
    id: "",
    parentId: null,
    title: title ?? md?.station ?? "",
    upnpClass: isRadio
      ? "object.item.audioItem.audioBroadcast"
      : "object.item.audioItem.musicTrack",
    isContainer: false,
    artUrl: md?.art_url ?? display?.art_url ?? null,
    artist,
    album,
    year: null,
    trackNumber: md?.track_number ?? null,
    durationSecs: md?.duration ?? display?.progress?.duration ?? null,
  };
  // A DISC finds its twin in the library only by the same names AND the same length (main's
  // contentMatch): its waveform, scenes and dynamic range are measured from that file, the
  // nearest thing to the disc the app can read (0.12.0, kept on purpose after a user saw it)
  const cd = isCdPlayback(md, display);
  const cdDuration = cd ? stub.durationSecs : null;
  // local media only: enrich from the library, by content
  const local =
    !isRadio &&
    !/airplay|cast|bluetooth|spotify|tidal|qobuz/i.test(
      `${klass ?? ""} ${stream.playbackSource ?? ""} ${stream.source ?? ""}`,
    );
  return {
    target: { node: stub, stream, serverName: null },
    localQuery:
      local && title && (!cd || cdDuration != null)
        ? {
            kind: "track",
            title,
            artist,
            album,
            artUrl: stub.artUrl,
            ...(cd ? { durationSecs: cdDuration } : {}),
          }
        : null,
  };
}

/**
 * Info for WHAT IS PLAYING NOW — every source. The streamer's own account of
 * the stream (codec, rate, depth, bitrate, source, controls…) opens at once;
 * for local media the library node is looked up by content and its sections
 * join (file format beside stream format, composers, disc, ids). Radio and
 * AirPlay have no library node and keep the stream page — no lookup, no
 * caveat, that IS the page. Nothing loaded → nothing to open. While the media
 * queue plays, ‹ › step through the queue from the playing entry (0.12.0, ⌘I,
 * lib/infoHotkey; the queue's rows as the Queue screen's Info steps them).
 */
export async function openInfoForNowPlaying(): Promise<void> {
  const s = useStore.getState();
  const built = nowPlayingInfoTarget(s.playState, s.nowPlaying);
  if (!built) return;
  const { target, localQuery } = built;
  const items = queueSourceActive(s) ? (s.queue?.items ?? []).filter((i) => i.id != null) : [];
  const playing = items.find((i) => i.id === s.effectivePlayId);
  const siblings = playing ? refSiblings(items, playing, fromQueueItem) : undefined;
  const list = siblings
    ? openInfoInList(
        target,
        siblings.refs.map((r) => () => lookupRefInfo(r)),
        siblings.index,
      )
    : null;
  if (!list) s.setMediaInfo(target);
  if (!localQuery) return;
  let found = null;
  try {
    found = await tt.mediaNodeInfo(localQuery, "show");
  } catch {
    found = null;
  }
  const current = useStore.getState().mediaInfo;
  if (!current || current.node !== target.node || !found) return;
  const enriched: MediaInfoTarget = {
    ...found,
    stream: target.stream,
    node: { ...found.node, artUrl: found.node.artUrl ?? target.node.artUrl },
  };
  if (list) replaceInfoInList(list, enriched);
  else s.setMediaInfo(enriched);
}
