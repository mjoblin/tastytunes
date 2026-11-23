import type { PushMessage, Snapshot, TastyTunesApi } from "@shared/ipc";
import type { AppSettings, LyricsQuery } from "@shared/model";

/**
 * THE WINDOW'S API, AS A PAGE ON THE NETWORK HAS IT (0.17.0, Display on other screens). The
 * Display tree is the app's own (one home), and it reaches the app through window.tastytunes; in a
 * browser there is no preload, so this stands in for it, answering from the display server's
 * reads (main/servers/displayServer): the snapshot, the live channel and the lyrics. It has no
 * way back: a command does nothing, and a settings change (a scene picked, the lyrics hidden)
 * stays in this page. Every other method answers as if there were nothing: an empty list or
 * null, and a listener that never fires.
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
    onPush: (cb: (msg: PushMessage) => void): (() => void) => {
      const live = new EventSource("/api/live");
      live.onmessage = (e: MessageEvent<string>) => {
        const msg = JSON.parse(e.data) as PushMessage;
        if (msg.kind === "settings") settings = msg.settings;
        cb(msg);
      };
      return () => live.close();
    },
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
  return new Proxy(known as TastyTunesApi, {
    get(target, name: string) {
      if (name in target) return target[name as keyof TastyTunesApi];
      if (/^on[A-Z]/.test(name)) return () => () => {};
      return () => Promise.resolve(LISTS.has(name) ? [] : null);
    },
  });
}
