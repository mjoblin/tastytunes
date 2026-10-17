import type { PushMessage } from "@shared/ipc";
import type { Playlist, RecentTrack } from "@shared/model";
import type { ZoneNowPlaying, ZonePlayState } from "@shared/smoip";
import { isRadioMetadata, radioTrackTitle, trackTitle } from "@shared/smoip";
import { getSettings } from "../data/persist";
import { clearRecents, getRecents, recentKey, recordRecent, restoreRecents } from "../data/recents";
import { addFavorite, getFavorites, removeFavorite, updateFavorite } from "../data/favorites";
import {
  appendToPlaylist,
  createPlaylist,
  deletePlaylist,
  getPlaylists,
  renamePlaylist,
  restorePlaylist,
  setPlaylistItems,
} from "../data/playlists";
import { CAPTURE_DELAY_MS, captureRecentArt, decorateRecents } from "../lookups/recentArt";

/** What the recents log reads off the device besides the play_state: the source and the streamer. */
export interface PlayContext {
  nowPlaying: ZoneNowPlaying | null;
  streamer: string | null;
}

/**
 * THE COLLECTIONS' WRITES (split out of DeviceManager in the 0.11.0 sweep): the recently
 * played log, favorites and playlists. Each mutates its bounded local file and pushes the
 * whole list, so every window sees it; the caller gets the list back. They were the device
 * manager's only for its push relay, which they borrow here.
 */
export class Collections {
  constructor(private readonly push: (msg: PushMessage) => void) {}

  // ------------------------------------------------------------- recently played

  /**
   * Log each track that plays. recordRecent() collapses consecutive repeats and
   * merges in late-arriving art, so this can fire on every play_state push.
   */
  recordRecentlyPlayed(ps: ZonePlayState, ctx: PlayContext): void {
    // the Recent list can be switched off (Settings › History); what it holds stays until cleared
    if (!getSettings().recents) return;
    // Only log active playback: on connect (or wake) the device re-announces a
    // paused/stopped track's metadata, which must not become a phantom row.
    if (ps.state !== "play" && ps.state !== "buffering") return;
    const md = ps.metadata;
    if (!md) return;
    const isRadio = isRadioMetadata(md);
    const station = md.station ?? null;
    // Radio titles normalize through the shared helper (absent / station-echo
    // "songs" become null) so recording and matching can never drift.
    const title = isRadio ? radioTrackTitle(md) : trackTitle(md);
    if (!title && !station) return; // nothing identifiable to log

    const sourceId = md.source ?? ctx.nowPlaying?.source?.id ?? null;
    // Continuous sources (radio, AirPlay, Spotify, …) group into one session; a
    // queued local track has a queue_id and stays a discrete row of its own.
    const session =
      ps.queue_id != null
        ? null
        : isRadio
          ? `radio:${station ?? sourceId ?? ""}`
          : `src:${sourceId ?? "stream"}`;

    const entry: RecentTrack = {
      at: Date.now(),
      title,
      artist: md.artist ?? null,
      album: md.album ?? null,
      station,
      artUrl: md.art_url ?? null,
      source: ctx.nowPlaying?.source?.name ?? md.source ?? null,
      sourceId,
      queueId: ps.queue_id ?? null,
      isRadio,
      radioId: md.radio_id ?? null,
      session,
      streamer: ctx.streamer,
    };
    const { list, changed } = recordRecent(entry);
    // a transient picture (AirPlay, casting) is captured while its URL lives,
    // a beat on: the log can wait, and the streamer's small HTTP server
    // should not be asked for the same picture by the capture, the accent
    // and the hero at once (the startup burst, 2026-09-06). ONE second, not
    // three (2026-09-15): the URL dies with the app's session, and a restart
    // five seconds after a track change lost the capture to this wait plus
    // the cache's write delay — the user's AirPlay cover gone after a dev
    // restart while the streamer showed it. A second still clears the burst.
    if (changed) {
      // capture the head AS IT IS when the timer fires, not as it was: a second
      // frame for the same track may have replaced the cover URL meanwhile
      // (the AirPlay first-frame case), and the merge now takes the newer one
      const key = recentKey(list[0]);
      setTimeout(() => {
        const head = getRecents()[0];
        if (head && recentKey(head) === key) captureRecentArt(head);
      }, CAPTURE_DELAY_MS);
    }
    if (changed) this.push({ kind: "recents", data: decorateRecents(list) });
  }

  /** The log again, with any picture captured since (the art cache's notifier). */
  repushRecents(): void {
    this.push({ kind: "recents", data: decorateRecents(getRecents()) });
  }

  clearRecents(): void {
    this.push({ kind: "recents", data: clearRecents() });
  }

  recentsRestore(list: Parameters<typeof restoreRecents>[0]): void {
    this.push({ kind: "recents", data: decorateRecents(restoreRecents(list)) });
  }

  // ------------------------------------------------------------------ favorites

  /** Favorites mutations live here so every window sees the push. */
  favoriteAdd(fav: Parameters<typeof addFavorite>[0]): ReturnType<typeof getFavorites> {
    const list = addFavorite(fav);
    this.push({ kind: "favorites", data: list });
    return list;
  }

  // Playlist writes mirror the favorites verbs: mutate the bounded local file,
  // push the whole list, return it to the caller that asked.
  private pushPlaylists(list: ReturnType<typeof getPlaylists>): ReturnType<typeof getPlaylists> {
    this.push({ kind: "playlists", data: list });
    return list;
  }

  /** Returns the CREATED playlist (its stored name may have been uniquified). */
  playlistCreate(name: string, items: Parameters<typeof createPlaylist>[1]): Playlist {
    const { list, created } = createPlaylist(name, items);
    this.pushPlaylists(list);
    return created;
  }

  playlistRename(id: string, name: string): ReturnType<typeof getPlaylists> {
    return this.pushPlaylists(renamePlaylist(id, name));
  }

  playlistDelete(id: string): ReturnType<typeof getPlaylists> {
    return this.pushPlaylists(deletePlaylist(id));
  }

  playlistRestore(
    playlist: Parameters<typeof restorePlaylist>[0],
  ): ReturnType<typeof getPlaylists> {
    return this.pushPlaylists(restorePlaylist(playlist));
  }

  playlistSetItems(
    id: string,
    items: Parameters<typeof setPlaylistItems>[1],
  ): ReturnType<typeof getPlaylists> {
    return this.pushPlaylists(setPlaylistItems(id, items));
  }

  playlistAppend(
    id: string,
    items: Parameters<typeof appendToPlaylist>[1],
  ): ReturnType<typeof getPlaylists> {
    return this.pushPlaylists(appendToPlaylist(id, items));
  }

  favoriteRemove(key: string): ReturnType<typeof getFavorites> {
    const list = removeFavorite(key);
    this.push({ kind: "favorites", data: list });
    return list;
  }

  favoriteUpdate(
    key: string,
    patch: Parameters<typeof updateFavorite>[1],
  ): ReturnType<typeof getFavorites> {
    const list = updateFavorite(key, patch);
    this.push({ kind: "favorites", data: list });
    return list;
  }
}
