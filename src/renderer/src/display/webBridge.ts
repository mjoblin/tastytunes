import { INVOKE_METHODS, type PushMessage, type Snapshot, type TastyTunesApi } from "@shared/ipc";
import type {
  AppSettings,
  AudioAnalysis,
  LyricsQuery,
  MediaInfoQuery,
  MediaInfoTarget,
} from "@shared/model";
import { listenPushes } from "./live";
import { forThisPage, keepOwn, OWN_KEYS } from "./pageSettings";

/**
 * THE WINDOW'S API, AS A PAGE ON THE NETWORK HAS IT (0.17.0, Display on other screens). The
 * Display tree is the app's own (one home), and it reaches the app through window.tastytunes; in a
 * browser there is no preload, so this stands in for it, answering from the display server's
 * reads (main/servers/displayServer): the snapshot, the live channel (display/live), the
 * playing track's lyrics, its analysis and its cover. It has no
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

/** The largest picture handed back as a data URL: the window's own cap (main/lookups/artFetch). */
export const ART_MAX_BYTES = 3_000_000;
/** The only pictures a page asks for: the server's own, by the id it handed out. */
const OWN_ART = /^\/art\/[0-9a-f]{24}$/;

function dataUrlOf(bytes: Uint8Array, type: string): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}

/** THE COVER, as the window's fetchArt gives it: the scenes take their colors from its pixels
 *  (components/display/palette) and the Turntable draws it (feed), each from a data URL so the
 *  cathode finish can read their canvases back. Same origin, the server's /art/<id> only, capped
 *  as the window caps it; anything else is null. */
export async function pageArt(url: string): Promise<{ dataUrl: string } | null> {
  if (!OWN_ART.test(url)) return null;
  try {
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) return null;
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    const length = Number(res.headers.get("content-length") ?? NaN);
    if (!/^image\/[\w.+-]+$/.test(type) || length > ART_MAX_BYTES) {
      await res.body?.cancel();
      return null;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.length > ART_MAX_BYTES ? null : { dataUrl: dataUrlOf(bytes, type) };
  } catch {
    return null;
  }
}

/** A cover past the streamer's own picture, which the server gives for the playing track only
 *  (main/servers/displayServer, /api/cover): a picture as a data URL, else null. */
async function pageCover(params: Record<string, string>): Promise<string | null> {
  try {
    const res = await fetch(`/api/cover?${new URLSearchParams(params).toString()}`, {
      credentials: "same-origin",
    });
    const got: unknown = res.ok ? await res.json() : null;
    return typeof got === "string" && got.startsWith("data:image/") ? got : null;
  } catch {
    return null;
  }
}

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
    // a change made on this page stays on this page: the settings a screen may keep (its scene,
    // the scenes' display-wide settings) are kept in its browser and outlast the app's pushes
    // (display/pageSettings); anything else lasts until the app's next word
    setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> => {
      keepOwn(patch);
      const rest = Object.entries(patch).filter(([k]) => !(OWN_KEYS as string[]).includes(k));
      settings = { ...settings!, ...Object.fromEntries(rest) };
      return Promise.resolve(forThisPage(settings));
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
    // THE SCENES' ANALYSIS (stage 2): the window's question for the playing file, answered by
    // the server for the playing track only, then its stored analysis by the key that came
    // with it; nothing on the page ever measures (the stream calls answer empty below)
    mediaNodeInfo: async (q: MediaInfoQuery) => {
      if (q.kind !== "track") return null;
      const p = new URLSearchParams({
        title: q.title,
        artist: q.artist ?? "",
        album: q.album ?? "",
        duration: q.durationSecs != null ? String(q.durationSecs) : "",
        art: q.artUrl ?? "",
      });
      const res = await fetch(`/api/track?${p.toString()}`, { credentials: "same-origin" });
      return res.ok ? ((await res.json()) as MediaInfoTarget | null) : null;
    },
    audioAnalysisGet: async (key: string) => {
      const res = await fetch(`/api/analysis?key=${encodeURIComponent(key)}`, {
        credentials: "same-origin",
      });
      return res.ok ? ((await res.json()) as AudioAnalysis | null) : null;
    },
    fetchArt: pageArt,
    // THE COVERS PAST THE STREAMER'S PICTURE, as the window's best-art rule asks them: a radio
    // song's own (lib/radioCover), and the log's copy of a cover whose address died (an AirPlay
    // session's, lib/bestArt)
    radioCover: (artist: string, song: string) => pageCover({ artist, song }),
    recentCover: (key: string) => pageCover({ key }),
    command: () => Promise.resolve(),
  };
  // EVERY method, written out from the channel table as the preload does, since the window's
  // wrapper (@/api) copies the methods it is given: the ones above answer, the rest answer empty
  const nothing = Object.fromEntries(
    INVOKE_METHODS.map((m) => [m, () => Promise.resolve(LISTS.has(m) ? [] : null)]),
  );
  return { ...nothing, reportDisplayMode: () => {}, ...known } as unknown as TastyTunesApi;
}
