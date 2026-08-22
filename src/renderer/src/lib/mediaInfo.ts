import type { MediaInfoQuery, MediaNode, StreamInfo } from "@shared/model";
import type { ZoneNowPlaying, ZonePlayState } from "@shared/smoip";
import { tt } from "@/api";
import { useStore } from "@/store";
import type { MediaRef } from "@/lib/mediaRef";

/**
 * Open the Info modal for something a LIST holds only a ref to (a queue row,
 * favorite, playlist item, recent, search hit). Main looks the node up —
 * index by id, then by content, then live BrowseMetadata — and the modal
 * shows everything found; when nothing is found it still opens on what the
 * list knew, with a caveat, rather than doing nothing. Stations have no
 * library node and are left to their own surfaces.
 */
export async function openInfoForRef(ref: MediaRef): Promise<void> {
  if (ref.kind === "station") return;
  const query: MediaInfoQuery = {
    kind: ref.kind,
    title: ref.title,
    artist: ref.artist,
    album: ref.album,
    serverUdn: ref.serverUdn,
    objectId: ref.objectId,
  };
  const set = useStore.getState().setMediaInfo;
  // open at once on what we have — the lookup usually lands within a beat and
  // simply enriches it (a click that does nothing while a live browse runs
  // reads as a dead menu item)
  const stub: MediaNode = {
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
  set({ node: stub, serverName: ref.serverName ?? null, note: "Looking it up in the library…" });
  let found = null;
  try {
    found = await tt.mediaNodeInfo(query);
  } catch {
    found = null;
  }
  // only replace if the user hasn't closed (or opened something else) meanwhile
  const current = useStore.getState().mediaInfo;
  if (!current || current.node !== stub) return;
  if (found) set({ ...found, serverName: found.serverName ?? ref.serverName ?? null });
  else
    set({
      node: stub,
      serverName: ref.serverName ?? null,
      note: "Not found in any library index — showing what this list knows.",
    });
}

/**
 * Info for WHAT IS PLAYING NOW — every source. The streamer's own account of
 * the stream (codec, rate, depth, bitrate, source, controls…) opens at once;
 * for local media the library node is looked up by content and its sections
 * join (file format beside stream format, composers, disc, ids). Radio and
 * AirPlay have no library node and keep the stream page — no lookup, no
 * caveat, that IS the page. Nothing loaded → nothing to open (the button
 * dims instead).
 */
export async function openInfoForNowPlaying(
  playState: ZonePlayState | null,
  nowPlaying: ZoneNowPlaying | null,
): Promise<void> {
  const md = playState?.metadata ?? null;
  const display = nowPlaying?.display ?? null;
  const klass = md?.class ?? display?.class ?? null;
  const isRadio = /radio/i.test(klass ?? "") || md?.station != null;
  const title = isRadio
    ? (md?.title ?? display?.line2 ?? md?.station ?? display?.line1 ?? null)
    : (md?.title ?? display?.line1 ?? null);
  if (!title && !md?.station) return;
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
    queuePosition: playState?.queue_index != null ? playState.queue_index + 1 : null,
    queueLength: playState?.queue_length ?? null,
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
  const set = useStore.getState().setMediaInfo;
  set({ node: stub, stream, serverName: null });
  // local media only: enrich from the library, by content
  const local =
    !isRadio &&
    !/airplay|cast|bluetooth|spotify|tidal|qobuz/i.test(
      `${klass ?? ""} ${stream.playbackSource ?? ""} ${stream.source ?? ""}`,
    );
  if (!local || !title) return;
  let found = null;
  try {
    found = await tt.mediaNodeInfo({ kind: "track", title, artist, album });
  } catch {
    found = null;
  }
  const current = useStore.getState().mediaInfo;
  if (!current || current.node !== stub || !found) return;
  set({ ...found, stream, node: { ...found.node, artUrl: found.node.artUrl ?? stub.artUrl } });
}
