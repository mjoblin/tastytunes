import { INVOKE_METHODS, type PushMessage, type Snapshot, type TastyTunesApi } from "@shared/ipc";
import type { AppSettings, LyricsQuery } from "@shared/model";
import { listenPushes } from "./live";

/**
 * THE WINDOW'S API, AS A PAGE ON THE NETWORK HAS IT (0.17.0, Display on other screens). The
 * Display tree is the app's own (one home), and it reaches the app through window.tastytunes; in a
 * browser there is no preload, so this stands in for it, answering from the display server's
 * reads (main/servers/displayServer): the snapshot, the live channel (display/live) and the
 * playing track's lyrics. It has no
 * way back: a command does nothing, and a settings change (a scene picked, the lyrics hidden)
 * stays in this page. Every other method answers as if there were nothing: an empty list or
 * null.
 */

const LISTS = new Set([
  "discover",
  "artistImages",
  "artistCommons",
  "getRecents",
  "mediaServers",
  "mediaSearchAll",
  "mediaIndexPools",
  "radioSearch",
  "radioTop",
  "radioByTags",
  "listeningYears",
]);

export function webBridge(): TastyTunesApi {
  let settings: AppSettings | null = null;
  listenPushes((msg) => {
    if (msg.kind === "settings") settings = msg.settings;
  });
  const known: Partial<TastyTunesApi> = {
    getSnapshot: async (): Promise<Snapshot> => {
      const res = await fetch("/api/snapshot", { credentials: "same-origin" });
      const snap = (await res.json()) as Snapshot;
      settings = snap.settings;
      return snap;
    },
    getSettings: async (): Promise<AppSettings> => {
      if (!settings) await known.getSnapshot!();
      return settings!;
    },
    // a change made on this page stays on this page
    setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> => {
      settings = { ...settings!, ...patch };
      return Promise.resolve(settings);
    },
    // the page's one live channel (display/live), which the page opens
    onPush: (cb: (msg: PushMessage) => void): (() => void) => listenPushes(cb),
    fetchLyrics: async (q: LyricsQuery) => {
      const p = new URLSearchParams({
        artist: q.artist,
        title: q.title,
        album: q.album ?? "",
        duration: q.duration != null ? String(q.duration) : "",
      });
      const res = await fetch(`/api/lyrics?${p.toString()}`, { credentials: "same-origin" });
      return res.ok
        ? ((await res.json()) as Awaited<ReturnType<TastyTunesApi["fetchLyrics"]>>)
        : null;
    },
    command: () => Promise.resolve(),
  };
  // EVERY method, written out from the channel table as the preload does, since the window's
  // wrapper (@/api) copies the methods it is given: the ones above answer, the rest answer empty
  const nothing = Object.fromEntries(
    INVOKE_METHODS.map((m) => [m, () => Promise.resolve(LISTS.has(m) ? [] : null)]),
  );
  return { ...nothing, reportDisplayMode: () => {}, ...known } as unknown as TastyTunesApi;
}
