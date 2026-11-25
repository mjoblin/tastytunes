import type { QueueList, QueueListItem, ZonePlayState } from "@shared/smoip";
import { nameKey } from "@shared/keys";
import { playingQueueEntry } from "@/lib/playingEntry";

/** The album being played, as lib/albumOnPlay measures it. */
export interface AlbumQueue {
  /** What this queue is (its album and its tracks, not where it has got to), so a new queue is
   *  told from the same one moving on. */
  sig: string;
  /** The queue's tracks in the order they are measured: from the next, wrapping round, the
   *  playing one last. */
  order: QueueListItem[];
}

/**
 * The queue as one album playing from a media server, or null when it is anything else: a
 * playlist or a mixed queue (every track must name the playing album), a single track, a queue
 * the app holds only part of, radio, a cast or a disc.
 */
export function albumQueue(
  queue: QueueList | null,
  playState: ZonePlayState | null,
): AlbumQueue | null {
  const md = playState?.metadata;
  const album = nameKey(md?.album);
  if (!md || md.source !== "MEDIA_PLAYER" || !album) return null;
  const items = queue?.items ?? [];
  if (items.length < 2) return null;
  if ((queue?.start ?? 0) !== 0 || (queue?.total ?? items.length) !== items.length) return null;
  if (items.some((i) => !i.metadata?.title || nameKey(i.metadata.album) !== album)) return null;
  const playing = playingQueueEntry(queue, playState);
  const at = playing ? items.indexOf(playing) : -1;
  if (at < 0) return null;
  const order = [...items.slice(at + 1), ...items.slice(0, at), items[at]];
  const sig = [
    album,
    ...items.map((i) => `${nameKey(i.metadata?.title)}|${i.metadata?.duration ?? ""}`),
  ].join("\n");
  return { sig, order };
}
