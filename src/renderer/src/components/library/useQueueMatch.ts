import { useMemo } from "react";
import type { MediaNode } from "@shared/model";
import type { QueueListItem } from "@shared/smoip";
import { tt } from "@/api";
import { useStore } from "@/store";
import { trackMatchesEntry } from "@/lib/playingEntry";
import { flashTarget } from "@/lib/scroll";

/** The Library's tracks against the queue: which are queued, and a bare click's jump to a
 *  queued entry instead of a duplicate. `insert` is the screen's PLAY_NOW write for a track
 *  that is not queued. (Split out of LibraryScreen in the 0.11.0 sweep.) */
export function useQueueMatch(insert: (node: MediaNode, el: HTMLElement | null) => void): {
  trackQueued: (node: MediaNode) => boolean;
  playTrack: (node: MediaNode, el: HTMLElement | null) => void;
} {
  const queue = useStore((s) => s.queue);
  const effectivePlayId = useStore((s) => s.effectivePlayId);
  // Title-keyed queue index: the content-match used to scan the whole queue
  // once per TRACK ROW per render (O(nodes × queue) under a 400-item grid);
  // one Map per queue push makes each lookup O(same-titled entries).
  const queueByTitle = useMemo(() => {
    const m = new Map<string, QueueListItem[]>();
    for (const i of queue?.items ?? []) {
      const t = i.metadata?.title;
      if (t == null || i.id == null) continue;
      const list = m.get(t);
      if (list) list.push(i);
      else m.set(t, [i]);
    }
    return m;
  }, [queue]);

  /**
   * Queue entries whose metadata content-matches a library track — the ONE
   * matcher (lib/playingEntry), so a compilation track whose entry carries
   * the album artist is found, not duplicated on click.
   */
  const queueMatches = (node: MediaNode): QueueListItem[] =>
    (queueByTitle.get(node.title) ?? []).filter((i) => trackMatchesEntry(node, i.metadata));
  const trackQueued = (node: MediaNode): boolean => queueMatches(node).length > 0;

  /**
   * Bare track click: if the track is already in the queue, JUMP to that
   * queue entry (first occurrence at-or-after the current position) instead
   * of inserting a duplicate — clicking an album you just queued navigates
   * it. Only genuinely un-queued tracks insert (PLAY_NOW). The ⋯ verbs stay
   * literal inserts.
   */
  const playTrack = (node: MediaNode, el: HTMLElement | null): void => {
    const items = queue?.items ?? [];
    const matches = queueMatches(node);
    if (matches.length > 0) {
      const curIdx = items.findIndex((i) => i.id === effectivePlayId);
      const target = matches.find((mi) => items.indexOf(mi) >= curIdx) ?? matches[0];
      void tt.command({ type: "playQueueId", queueId: target.id as number });
      if (el) flashTarget(el);
      return;
    }
    insert(node, el);
  };
  return { trackQueued, playTrack };
}
