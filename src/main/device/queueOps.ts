import type {
  ContentRef,
  PlaylistActivation,
  PlaylistItem,
  QueueRestoreResult,
} from "@shared/model";
import type { PushMessage } from "@shared/ipc";
import type { MediaQueueAction } from "@shared/model";
import type { QueueList } from "@shared/smoip";
import type { SmoipSocket } from "./smoipSocket";
import * as smoipHttp from "./smoipHttp";
import { getPlaylists, healPlaylistItem, markPlaylistPlayed } from "../data/playlists";
import { listeningRecord } from "../data/listeningRecord";
import { queueAdd } from "../media/upnpBrowser";
import { resolveContent, type ResolvedContent } from "../media/resolveContent";

/**
 * The queue-ops engine: everything that WRITES to the streamer's queue on the
 * app's behalf and has to survive doing it slowly — playlist activation, the
 * queue's undo, and the content resolution both lean on.
 *
 * Extracted from deviceManager 2026-07-26. It was ~250 lines of the most
 * invariant-dense code in the app sitting in the middle of a class otherwise
 * about connections and frames; the manager now owns ONE instance and keeps
 * thin delegating methods, so the IPC surface and mcpServer are unchanged.
 *
 * THE INVARIANTS, which are the reason this is one object and not five loose
 * functions — every one of them was learned from a bug:
 *
 *  1. ONE RUN AT A TIME, and the claim is SYNCHRONOUS with the check. There
 *     must be no `await` between reading `activation` and writing it. The UI
 *     greys its Play buttons during a run but MCP's play_playlist has no such
 *     gate, and two interleaved runs would fight over REPLACE/APPEND, over the
 *     batch flags, and over the activation object itself — the second run's
 *     `finally` would finish the first run's state.
 *  2. SUPPRESS AT THE WIRE **AND** AT THE PUSH, then ONE reconciling
 *     /queue/list. Every add emits /queue/info, which normally triggers a full
 *     refetch; `socket.suppressQueueRefetch` stops the wire chatter and
 *     `batching` stops the renderer churn, and the single read at the end is
 *     what makes the pair safe. vibin used a bare boolean that cleared before
 *     the adds had settled — that is the bug this shape exists to avoid.
 *  3. `batchStarted` GATES lastPlayedAt AND the cleanup send. A run that dies
 *     waking the device never touched the queue: stamping it as played, or
 *     firing a reconciling read for adds that never happened, would both be
 *     small lies.
 *  4. HEAL BY INDEX, VERIFYING CONTENT IDENTITY. A stale objectId is not a
 *     failure — ids are hints, content is identity — so a miss re-resolves by
 *     search and repairs the stored entry in place, with no updatedAt bump so
 *     the collection keeps its order.
 *
 * The engine reads the manager's live state through `QueueOpsHost` rather than
 * holding its own copies: `socket` and `queue` change under it as frames
 * arrive, and a snapshot taken at construction would go stale immediately.
 */
export interface QueueOpsHost {
  /** The connected host, or null when there is no connection to write to. */
  host(): string | null;
  /** The live socket — may be null, and may go null mid-run. */
  socket(): SmoipSocket | null;
  /** The manager's cached /queue/list, as fresh as the last frame. */
  queue(): QueueList | null;
  push(msg: PushMessage): void;
  /** Activating is a play-shaped intent, so it wakes a sleeping streamer first. */
  ensureAwake(): Promise<void>;
}

export class QueueOps {
  private readonly host: QueueOpsHost;
  private batch = false;
  private current: PlaylistActivation | null = null;
  /** A list of tracks being queued (queueTracks), which holds the one-run claim as a playlist does. */
  private tracksRunning = false;
  private cancelled = false;

  constructor(host: QueueOpsHost) {
    this.host = host;
  }

  /**
   * True while a batch is loading. The manager's frame handler reads this to
   * hold back /queue/list pushes — invariant 2's renderer half.
   */
  get batching(): boolean {
    return this.batch;
  }

  /** Live activation state, for the boot snapshot and the push relay. */
  get activation(): PlaylistActivation | null {
    return this.current;
  }

  cancelActivation(): void {
    if (this.current && !this.current.finished) this.cancelled = true;
  }

  /**
   * Replace the streamer's queue with a stored playlist.
   *
   * Shape dictated by the firmware (confirmed against vibin, which solved this
   * first): entries go in ONE AT A TIME and each needs its media server's DIDL,
   * so this is ~2 round-trips per track and genuinely slow — hence progress and
   * cancellation.
   */
  async playlistActivate(id: string): Promise<PlaylistActivation> {
    const playlist = getPlaylists().find((p) => p.id === id);
    if (!playlist) throw new Error("No such playlist");
    const host = this.host.host();
    if (!host) throw new Error("Not connected");
    // INVARIANT 1 — the claim below is synchronous with this check: no await
    // between them.
    if (this.current && !this.current.finished) {
      throw new Error(`Already loading “${this.current.name}”. Cancel that run first.`);
    }
    if (this.tracksRunning) throw new Error("Already queueing tracks. Try again when that's done.");

    this.cancelled = false;
    const activation: PlaylistActivation = {
      playlistId: id,
      name: playlist.name,
      total: playlist.items.length,
      done: 0,
      added: 0,
      missed: [],
      cancelled: false,
      finished: false,
    };
    this.current = activation;
    // the record: what plays from here started from this playlist, bound to the
    // entries once the batch has appended them all
    listeningRecord.openContext(
      { kind: "playlist", id, name: playlist.name },
      { holdBinding: true },
    );
    const announce = (): void => this.host.push({ kind: "playlistActivation", state: activation });
    announce();

    // INVARIANT 3 — nothing has touched the queue until the batch starts.
    const run = { started: false };
    try {
      await this.addEach(
        host,
        playlist.items,
        // The FIRST successful add REPLACEs (clearing what was there); everything after appends.
        // Keyed off success, not index: if entry one can't be resolved, entry two must still be
        // the one that clears the old queue.
        (_index, landed) => (landed > 0 ? "APPEND" : "REPLACE"),
        (index, landed, found) => {
          // heal in place, no updatedAt bump, so the collection keeps its order
          if (found) healPlaylistItem(id, index, playlist.items[index], found);
          if (landed) activation.added += 1;
          else activation.missed.push(playlist.items[index].title);
          activation.done += 1;
          announce();
        },
        run,
      );
    } finally {
      const batchStarted = run.started;
      activation.cancelled = this.cancelled;
      activation.finished = true;
      if (batchStarted) listeningRecord.releaseContextBinding();
      else listeningRecord.endContext();
      // INVARIANT 3 — stamp the attempt only if the queue was actually touched.
      if (batchStarted) markPlaylistPlayed(id, activation.missed);
      announce();
      this.host.push({ kind: "playlists", data: getPlaylists() });
    }
    return activation;
  }

  /**
   * THE BATCH (0.16.0: the playlist activation's loop lifted out, so a list of tracks an agent
   * queues runs on it too, and the invariants have one home). The entries go in one at a time, in
   * the order given, each by its ids first and by content on a miss (invariant 4); the queue
   * refetch is suppressed at the wire and the push until one reconciling read at the end
   * (invariant 2); a run left behind by a switch to another streamer, or a disconnect, stops there
   * (as a cancel) rather than adding the rest to a streamer no longer chosen, the socket's host
   * surviving a reconnect to the same one. `actionFor` gives each entry's verb from how many landed
   * before it; `onEntry` hears each entry tried, with `found` when it landed by content.
   * `run.started` says whether the batch started (invariant 3: a run that died waking the device
   * never touched the queue), set even when this throws.
   */
  private async addEach(
    host: string,
    items: readonly PlaylistItem[],
    actionFor: (index: number, landed: number) => MediaQueueAction,
    onEntry: (index: number, landed: boolean, found: ResolvedContent | null) => void,
    run: { started: boolean },
  ): Promise<void> {
    let landedCount = 0;
    try {
      await this.host.ensureAwake(); // queueing is a play-shaped intent

      this.batch = true;
      run.started = true;
      const socket = this.host.socket();
      if (socket) socket.suppressQueueRefetch = true;
      const leftBehind = (): boolean => this.host.socket()?.host !== host;
      for (const [index, item] of items.entries()) {
        if (!this.cancelled && leftBehind()) this.cancelled = true;
        if (this.cancelled) break;
        const action = actionFor(index, landedCount);
        let landed = false;
        let healed: ResolvedContent | null = null;

        if (item.serverUdn && item.objectId) {
          try {
            await queueAdd(host, item.serverUdn, item.objectId, action);
            landed = true;
          } catch {
            // stale id — fall through to the content re-resolve
          }
        }

        // left behind mid-entry: stopped before this entry is counted, so it isn't marked missed
        if (!landed && !this.cancelled && leftBehind()) this.cancelled = true;
        if (this.cancelled && !landed) break;

        if (!landed) {
          // INVARIANT 4. This used to walk `searchable` servers only, which
          // meant an entry living on a Browse-only server (USB) could never
          // heal; resolveContent asks the indexes first, so it can.
          const found = await resolveContent(host, item);
          if (found) {
            try {
              await queueAdd(host, found.serverUdn, found.objectId, action);
              landed = true;
              healed = found;
            } catch {
              // couldn't add it after all — counted as missed
            }
          }
        }

        if (landed) landedCount += 1;
        onEntry(index, landed, healed);
      }
    } finally {
      this.batch = false;
      // Re-read the socket: a run can outlive the connection it started on.
      const socket = this.host.socket();
      if (socket) socket.suppressQueueRefetch = false;
      if (run.started) {
        // INVARIANT 2's single authoritative read of the truth, whatever
        // happened above. The send throws on a half-dead socket (by design);
        // swallowed HERE only, so cleanup can't mask the loop's real error —
        // reconnect resubscribes /queue/list and delivers the same truth anyway.
        try {
          socket?.send("/queue/list");
        } catch {
          /* reconnect refetches */
        }
      }
    }
  }

  /**
   * A list of tracks into the queue in one write (0.16.0, play_media's items), on the batch the
   * playlists run on, in the order given whatever the verb: replace and append go in as listed;
   * play_next inserts each right after the playing track, so the list goes in reversed; play_now
   * plays the first and the rest follow it, so the rest go in reversed as next and the first goes
   * last, played now. Says how many landed, the titles that didn't (any left untried by a
   * cancel too), and, for a replace that touched the queue, how long the queue it replaced was.
   */
  async queueTracks(
    items: readonly PlaylistItem[],
    mode: "play_now" | "play_next" | "append" | "replace",
  ): Promise<{ added: number; missed: string[]; total: number; replaced: number | null }> {
    const host = this.host.host();
    if (!host) throw new Error("Not connected");
    // INVARIANT 1 — the claim below is synchronous with these checks
    if (this.current && !this.current.finished)
      throw new Error(`Already loading “${this.current.name}”. Try again when that's done.`);
    if (this.tracksRunning) throw new Error("Already queueing tracks. Try again when that's done.");
    this.tracksRunning = true;
    this.cancelled = false;
    const before = this.host.queue()?.total ?? 0;
    const n = items.length;
    const order =
      mode === "play_next"
        ? items.map((_, i) => n - 1 - i)
        : mode === "play_now"
          ? [...items.map((_, i) => n - 1 - i).slice(0, n - 1), 0]
          : items.map((_, i) => i);
    const landedAt = new Set<number>();
    const run = { started: false };
    try {
      await this.addEach(
        host,
        order.map((i) => items[i]),
        (index, landed) =>
          mode === "replace"
            ? landed > 0
              ? "APPEND"
              : "REPLACE"
            : mode === "append"
              ? "APPEND"
              : mode === "play_now" && index === n - 1
                ? "PLAY_NOW"
                : "PLAY_NEXT",
        (index, landed) => {
          if (landed) landedAt.add(order[index]);
        },
        run,
      );
    } finally {
      this.tracksRunning = false;
    }
    return {
      added: landedAt.size,
      missed: items.filter((_, i) => !landedAt.has(i)).map((t) => t.title),
      total: n,
      replaced: mode === "replace" && run.started && landedAt.size > 0 ? before : null,
    };
  }

  /**
   * Put a removed track back in the queue at `position` — the undo behind the
   * queue's ×.
   *
   * BEST-EFFORT BY NATURE, and the honesty matters more than the success rate.
   * A queue row carries no serverUdn/objectId (QueueListItem is id/position/
   * metadata), and the firmware's queue/add needs DIDL for a specific object,
   * so this is a re-RESOLVE and re-ADD, not a rollback: find the track by
   * content, append it, then move it from the end back to where it was. Every
   * path that fills a queue goes through a media server, so in practice the
   * resolve succeeds; when it can't, the caller says so rather than pretending.
   *
   * The position restore is deliberately not fatal — a track back in the wrong
   * slot beats a track that didn't come back.
   */
  async queueRestore(ref: ContentRef, position: number): Promise<QueueRestoreResult> {
    const host = this.host.host();
    if (!host) return { status: "failed" };

    const found = await resolveContent(host, ref);
    if (!found) return { status: "not-found" };

    const before = this.host.queue()?.items?.length ?? 0;
    try {
      await queueAdd(host, found.serverUdn, found.objectId, "APPEND");
    } catch {
      return { status: "failed" };
    }

    // APPEND lands at the end, but the id it landed under only arrives with the
    // next /queue/list push — ask for one and wait for the queue to actually
    // grow rather than assuming a fixed delay.
    try {
      this.host.socket()?.send("/queue/list");
    } catch {
      return { status: "ok" }; // it IS in the queue; reconnect will refetch and show it
    }
    const grown = await this.waitForQueue((q) => (q.items?.length ?? 0) > before, 4000);
    if (!grown) return { status: "ok" };

    const items = grown.items ?? [];
    const from = items.length - 1;
    const landed = items[from];
    const to = Math.max(0, Math.min(position, from));
    if (landed?.id != null && to !== from) {
      try {
        await smoipHttp.queueMove(host, landed.id, from, to);
      } catch {
        // it's in the queue, just not where it was — see the doc comment
      }
    }
    return landed?.id != null ? { status: "ok", id: landed.id } : { status: "ok" };
  }

  /**
   * Renderer-facing content resolution — the same index-first, live-fallback
   * search queue undo and playlist healing use, exposed so ANY surface can act
   * on a track it knows only by content (a recently-played entry, a favorite
   * whose server changed). Null when disconnected or nothing matches.
   */
  async contentResolve(ref: ContentRef): Promise<ResolvedContent | null> {
    const host = this.host.host();
    if (!host) return null;
    return resolveContent(host, ref);
  }

  /** Resolve with the first cached queue satisfying `test`, or null on timeout. */
  private waitForQueue(
    test: (q: QueueList) => boolean,
    timeoutMs: number,
  ): Promise<QueueList | null> {
    const now = this.host.queue();
    if (now && test(now)) return Promise.resolve(now);
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = setInterval(() => {
        const q = this.host.queue();
        if (q && test(q)) {
          clearInterval(tick);
          resolve(q);
        } else if (Date.now() - started >= timeoutMs) {
          clearInterval(tick);
          resolve(null);
        }
      }, 120);
    });
  }
}
