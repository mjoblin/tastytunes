import { useMemo } from "react";
import type { MediaNode } from "@shared/model";
import type { ZonePlayState } from "@shared/smoip";
import { useStore } from "@/store";
import { useQueueSourceActive } from "@/hooks/useQueueSourceActive";
import { useIndexPools } from "@/hooks/useIndexPools";
import {
  albumMatchesEntry,
  amongPlayingCopies,
  entryArtistMatches,
  playingCopies,
  playingQueueEntry,
  trackMatchesEntry,
} from "@/lib/playingEntry";

/**
 * Playing-item highlight, queue-screen rules: library items carry no queue
 * ids, so match by content — against the PLAYING QUEUE ENTRY's metadata
 * (server-shaped, the same strings the library shows; see lib/playingEntry:
 * play_state.metadata is the streamer's FILE-TAG readout and disagrees with
 * the server on every album Asset renames), falling back to that readout
 * only while the queue isn't known. Only while the queue's source is audible.
 * (Split out of LibraryScreen in the 0.11.0 sweep.)
 */
export function usePlayingMatch(): {
  md: ZonePlayState["metadata"] | null;
  queueSourceActive: boolean;
  isCurrentTrack: (node: MediaNode) => boolean;
  isPlayingAlbum: (node: MediaNode) => boolean;
} {
  const playState = useStore((s) => s.playState);
  const queue = useStore((s) => s.queue);
  const effectivePlayId = useStore((s) => s.effectivePlayId);
  const queueSourceActive = useQueueSourceActive();
  const md = playState?.metadata ?? null;
  const playingEntry = playingQueueEntry(queue, playState, effectivePlayId)?.metadata ?? null;
  const pools = useIndexPools();
  const streamerHost = useStore((s) =>
    s.connection.phase === "connected" ? s.connection.host : null,
  );
  // the copies the playing entry can be, of its album and of its track, out of every copy the
  // indexes hold (lib/playingEntry playingCopyKeys): one lit where the entry says which
  const copies = useMemo(() => {
    if (!playingEntry || !pools) return { albums: null, tracks: null };
    const stamp = (n: MediaNode, udn: string): MediaNode =>
      n.serverUdn ? n : { ...n, serverUdn: udn };
    const albums = pools.flatMap((p) =>
      p.albums.filter((n) => albumMatchesEntry(n, playingEntry)).map((n) => stamp(n, p.udn)),
    );
    const tracks = pools.flatMap((p) =>
      p.tracks.filter((n) => trackMatchesEntry(n, playingEntry)).map((n) => stamp(n, p.udn)),
    );
    return {
      albums: playingCopies(playingEntry, albums, streamerHost, false),
      tracks: playingCopies(playingEntry, tracks, streamerHost, true),
    };
  }, [playingEntry, pools, streamerHost]);
  const isCurrentTrack = (node: MediaNode): boolean =>
    playingEntry != null
      ? trackMatchesEntry(node, playingEntry) && amongPlayingCopies(copies.tracks, node, true)
      : md != null &&
        node.title === md.title &&
        (node.album == null || md.album == null || node.album === md.album) &&
        entryArtistMatches(md.artist, node) &&
        // Twin titles on one album (a reprise, a bonus cut) are real — duration
        // is the content identity left, so require agreement when both sides
        // know it (±2s: the device and UPnP round track lengths differently).
        (node.durationSecs == null ||
          md.duration == null ||
          Math.abs(node.durationSecs - md.duration) <= 2);
  const isPlayingAlbum = (node: MediaNode): boolean =>
    playingEntry != null
      ? albumMatchesEntry(node, playingEntry) && amongPlayingCopies(copies.albums, node, false)
      : md != null && md.album === node.title && entryArtistMatches(md.artist, node);
  return { md, queueSourceActive, isCurrentTrack, isPlayingAlbum };
}
