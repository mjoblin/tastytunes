import type { ContentRef, PlaylistActivation, QueueRestoreResult } from '@shared/model'
import type { PushMessage } from '@shared/ipc'
import type { MediaQueueAction } from '@shared/model'
import type { QueueList } from '@shared/smoip'
import type { SmoipSocket } from './smoipSocket'
import * as smoipHttp from './smoipHttp'
import { getPlaylists, healPlaylistItem, markPlaylistPlayed } from '../data/playlists'
import { queueAdd } from '../media/upnpBrowser'
import { resolveContent, type ResolvedContent } from '../media/resolveContent'

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
  host(): string | null
  /** The live socket — may be null, and may go null mid-run. */
  socket(): SmoipSocket | null
  /** The manager's cached /queue/list, as fresh as the last frame. */
  queue(): QueueList | null
  push(msg: PushMessage): void
  /** Activating is a play-shaped intent, so it wakes a sleeping streamer first. */
  ensureAwake(): Promise<void>
}

export class QueueOps {
  private readonly host: QueueOpsHost
  private batch = false
  private current: PlaylistActivation | null = null
  private cancelled = false

  constructor(host: QueueOpsHost) {
    this.host = host
  }

  /**
   * True while a batch is loading. The manager's frame handler reads this to
   * hold back /queue/list pushes — invariant 2's renderer half.
   */
  get batching(): boolean {
    return this.batch
  }

  /** Live activation state, for the boot snapshot and the push relay. */
  get activation(): PlaylistActivation | null {
    return this.current
  }

  cancelActivation(): void {
    if (this.current && !this.current.finished) this.cancelled = true
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
    const playlist = getPlaylists().find((p) => p.id === id)
    if (!playlist) throw new Error('No such playlist')
    const host = this.host.host()
    if (!host) throw new Error('Not connected')
    // INVARIANT 1 — the claim below is synchronous with this check: no await
    // between them.
    if (this.current && !this.current.finished) {
      throw new Error(`Already loading "${this.current.name}" — cancel that run first`)
    }

    this.cancelled = false
    const activation: PlaylistActivation = {
      playlistId: id,
      name: playlist.name,
      total: playlist.items.length,
      done: 0,
      added: 0,
      missed: [],
      cancelled: false,
      finished: false
    }
    this.current = activation
    const announce = (): void => this.host.push({ kind: 'playlistActivation', state: activation })
    announce()

    // INVARIANT 3 — nothing has touched the queue until this flips.
    let batchStarted = false

    // The FIRST successful add REPLACEs (clearing what was there); everything
    // after appends. Keyed off success, not index — if entry one can't be
    // resolved, entry two must still be the one that clears the old queue.
    let replaced = false
    try {
      await this.host.ensureAwake() // activating is a play-shaped intent

      this.batch = true
      batchStarted = true
      const socket = this.host.socket()
      if (socket) socket.suppressQueueRefetch = true
      for (const [index, item] of playlist.items.entries()) {
        if (this.cancelled) break
        const action: MediaQueueAction = replaced ? 'APPEND' : 'REPLACE'
        let landed = false

        if (item.serverUdn && item.objectId) {
          try {
            await queueAdd(host, item.serverUdn, item.objectId, action)
            landed = true
          } catch {
            // stale id — fall through to the content re-resolve
          }
        }

        if (!landed && !this.cancelled) {
          // INVARIANT 4. This used to walk `searchable` servers only, which
          // meant an entry living on a Browse-only server (USB) could never
          // heal; resolveContent asks the indexes first, so it can.
          const found = await resolveContent(host, item)
          if (found) {
            try {
              await queueAdd(host, found.serverUdn, found.objectId, action)
              landed = true
              // heal in place — no updatedAt bump, so the collection keeps its order
              healPlaylistItem(id, index, item, found)
            } catch {
              // couldn't add it after all — counted as missed below
            }
          }
        }

        if (landed) {
          replaced = true
          activation.added += 1
        } else {
          activation.missed.push(item.title)
        }
        activation.done += 1
        announce()
      }
    } finally {
      this.batch = false
      // Re-read the socket: a run can outlive the connection it started on.
      const socket = this.host.socket()
      if (socket) socket.suppressQueueRefetch = false
      if (batchStarted) {
        // INVARIANT 2's single authoritative read of the truth, whatever
        // happened above. The send throws on a half-dead socket (by design);
        // swallowed HERE only, so cleanup can't mask the loop's real error —
        // reconnect resubscribes /queue/list and delivers the same truth anyway.
        try {
          socket?.send('/queue/list')
        } catch {
          /* reconnect refetches */
        }
      }
      activation.cancelled = this.cancelled
      activation.finished = true
      // INVARIANT 3 — stamp the attempt only if the queue was actually touched.
      if (batchStarted) markPlaylistPlayed(id, activation.missed)
      announce()
      this.host.push({ kind: 'playlists', data: getPlaylists() })
    }
    return activation
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
    const host = this.host.host()
    if (!host) return 'failed'

    const found = await resolveContent(host, ref)
    if (!found) return 'not-found'

    const before = this.host.queue()?.items?.length ?? 0
    try {
      await queueAdd(host, found.serverUdn, found.objectId, 'APPEND')
    } catch {
      return 'failed'
    }

    // APPEND lands at the end, but the id it landed under only arrives with the
    // next /queue/list push — ask for one and wait for the queue to actually
    // grow rather than assuming a fixed delay.
    try {
      this.host.socket()?.send('/queue/list')
    } catch {
      return 'ok' // it IS in the queue; reconnect will refetch and show it
    }
    const grown = await this.waitForQueue((q) => (q.items?.length ?? 0) > before, 4000)
    if (!grown) return 'ok'

    const items = grown.items ?? []
    const from = items.length - 1
    const landed = items[from]
    const to = Math.max(0, Math.min(position, from))
    if (landed?.id != null && to !== from) {
      try {
        await smoipHttp.queueMove(host, landed.id, from, to)
      } catch {
        // it's in the queue, just not where it was — see the doc comment
      }
    }
    return 'ok'
  }

  /**
   * Renderer-facing content resolution — the same index-first, live-fallback
   * search queue undo and playlist healing use, exposed so ANY surface can act
   * on a track it knows only by content (a recently-played entry, a favorite
   * whose server changed). Null when disconnected or nothing matches.
   */
  async contentResolve(ref: ContentRef): Promise<ResolvedContent | null> {
    const host = this.host.host()
    if (!host) return null
    return resolveContent(host, ref)
  }

  /** Resolve with the first cached queue satisfying `test`, or null on timeout. */
  private waitForQueue(test: (q: QueueList) => boolean, timeoutMs: number): Promise<QueueList | null> {
    const now = this.host.queue()
    if (now && test(now)) return Promise.resolve(now)
    return new Promise((resolve) => {
      const started = Date.now()
      const tick = setInterval(() => {
        const q = this.host.queue()
        if (q && test(q)) {
          clearInterval(tick)
          resolve(q)
        } else if (Date.now() - started >= timeoutMs) {
          clearInterval(tick)
          resolve(null)
        }
      }, 120)
    })
  }
}
