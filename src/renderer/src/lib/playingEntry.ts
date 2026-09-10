import type { MediaNode } from "@shared/model";
import { trackArtists } from "@shared/model";
import type { QueueList, QueueListItem, QueueListItemMetadata, ZonePlayState } from "@shared/smoip";

/**
 * What the matchers need of a queue entry's metadata — the shape a SAVED item
 * (favorite, playlist entry) maps onto too, since it stored exactly these
 * fields from the queue it came from.
 */
export type EntryLike = Pick<QueueListItemMetadata, "title" | "artist" | "album" | "duration">;

/**
 * WHICH QUEUE ENTRY IS PLAYING, and does a library item match it.
 *
 * The streamer's play_state.metadata is its FILE-TAG readout: from the first
 * push of a track it reports what the decoder read from the file, not what
 * the media server said about it (live trace across a track change,
 * 2026-08-21). The two differ wherever the server normalises tags — Asset
 * merges "[Disc n]" folders into one multi-disc album and renames it, so the
 * readout says "Nature's Best 2 [Disc 1]" while Asset's DIDL, the parser and
 * the QUEUE ENTRY all say "Nature's Best 2" — and a library row that compares
 * the server's string with the device's can never light on such an album.
 *
 * So the identity a library item is matched against is the playing QUEUE
 * ENTRY (play_state names it by id), whose metadata the streamer took from
 * the DIDL it was queued with — the same shape the library shows. The tag
 * readout stays as the fallback for the moments the queue isn't known.
 */
export function playingQueueEntry(
  queue: QueueList | null,
  playState: ZonePlayState | null,
  /** The store's settled id (see contentPlayId); the raw pointer when absent. */
  effectiveId?: number | null,
): QueueListItem | null {
  const playId = effectiveId ?? queue?.play_id ?? playState?.queue_id ?? null;
  if (playId == null) return null;
  return queue?.items?.find((i) => i.id === playId) ?? null;
}

/**
 * THE POINTER CAN LIE (live, the user's Evo, 2026-09-02). A queue edit that
 * lands after the decoder has pre-opened the next file makes the streamer
 * PLAY the prefetched file — audio and tag readout both the old next — while
 * its queue pointer (play_id / queue_id / queue_index) advances to whatever
 * now sits in the next slot. For one track the device's own report describes
 * two songs, and an app that mirrors it shows Now Playing (the readout) and
 * the Queue's playing row (the pointer) disagreeing — the 2026-08-28 report.
 *
 * The readout is the audible truth, so the playing row should follow CONTENT
 * when the pointer's entry does not match it. STRICTLY: title equal and
 * duration within 2s, and exactly one other entry matching — the readout
 * legitimately differs from an entry on renaming servers (Asset's "[Disc n]"
 * merge changes the album, never title or length), and duplicates of the
 * playing entry match the pointer's entry too, so neither can re-target.
 * Callers settle the disagreement for PLAYING_SETTLE_MS before acting on it:
 * at an ordinary boundary the pointer and the readout arrive as separate
 * pushes and disagree for a moment.
 */
export const PLAYING_SETTLE_MS = 3000;

export function entryMatchesReadout(
  entry: QueueListItem,
  md: EntryLike | null | undefined,
): boolean {
  const e = entry.metadata;
  if (md == null || md.title == null || e?.title == null) return false;
  return (
    e.title === md.title &&
    (e.duration == null || md.duration == null || Math.abs(e.duration - md.duration) <= 2)
  );
}

/** The raw pointer, and the entry the READOUT names when the pointer's entry
 *  does not (null when they agree, or when no single entry matches). */
export function contentPlayId(
  queue: QueueList | null,
  playState: ZonePlayState | null,
): { raw: number | null; content: number | null } {
  const raw = queue?.play_id ?? playState?.queue_id ?? null;
  const md = playState?.metadata;
  const items = queue?.items;
  if (raw == null || !md?.title || !items) return { raw, content: null };
  const pointed = items.find((i) => i.id === raw);
  if (!pointed || entryMatchesReadout(pointed, md)) return { raw, content: null };
  const matches = items.filter((i) => entryMatchesReadout(i, md));
  return { raw, content: matches.length === 1 ? matches[0].id : null };
}

const sameName = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A queue entry's `artist` is the DIDL's first upnp:artist — the ALBUM ARTIST
 * where the server sends one ("Various Artists" on a compilation track whose
 * performer is Straitjacket Fits), a performer otherwise. So the entry
 * matches a library item when its artist is ANY of the item's identities —
 * album artist or performers (trackArtists) — never the packed display
 * string alone. An entry with no artist, or an item with none, is not held
 * against the match.
 */
export function entryArtistMatches(
  entryArtist: string | null | undefined,
  item: Pick<MediaNode, "artist" | "artists" | "albumArtist">,
): boolean {
  if (entryArtist == null || entryArtist.trim() === "") return true;
  const names = [item.albumArtist, ...trackArtists(item)].filter((n): n is string => !!n);
  if (names.length === 0) return true;
  return names.some((n) => sameName(n, entryArtist));
}

/**
 * Does a library TRACK match a queue entry's metadata? Title, album and
 * artist by the rules above; duration within ±2s when both sides know it —
 * twin titles on one album (a reprise, a bonus cut) are real, and duration
 * is the content identity left (the device and UPnP round lengths
 * differently).
 */
export function trackMatchesEntry(node: MediaNode, m: EntryLike | null | undefined): boolean {
  if (m == null || m.title == null) return false;
  return (
    node.title === m.title &&
    (node.album == null || m.album == null || node.album === m.album) &&
    entryArtistMatches(m.artist, node) &&
    (node.durationSecs == null ||
      m.duration == null ||
      Math.abs(node.durationSecs - m.duration) <= 2)
  );
}

/** Does a library ALBUM (container node) own a queue entry? Album title + artist identity. */
export function albumMatchesEntry(node: MediaNode, m: EntryLike | null | undefined): boolean {
  if (m == null || m.album == null) return false;
  return m.album === node.title && entryArtistMatches(m.artist, node);
}
