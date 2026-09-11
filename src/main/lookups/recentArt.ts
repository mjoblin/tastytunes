import { nativeImage } from "electron";
import { playKey, type RecentTrack } from "@shared/model";
import { DiskCache } from "./diskCache";

/**
 * The device log's ART CACHE (2026-09-05, History round two). A track played
 * from a source other than the library (AirPlay, casting, the streamer's own
 * services) shows art the STREAMER serves from a per-session endpoint
 * (`/album-art-<session>?id=…`), and that URL dies the moment the source
 * changes — the Recent view and the Timeline then showed an icon. So the
 * picture is fetched NOW, while the URL is alive, shrunk to a 160px JPEG
 * (rows draw art at 40px; 160 covers a 2× display), and kept on the DiskCache
 * chassis keyed by the track's content identity (playKey): bounded by a hard
 * cap, evicting the coldest, shown and cleared with the other lookup caches
 * in Settings — no storage knob (the record's own no-knob decision).
 * Library art (the media server's) and radio art (Airable's logos) are
 * durable URLs and are never captured.
 */
const cache = new DiskCache<string>("recentart", 600);
const THUMB = 160;
/** The same capture at hero size, for the Now Playing tile and display mode
 *  when the streamer's URL has died (2026-09-06: an AirPlay cover's URL
 *  answered 500 for the whole track after an app restart while the Evo's own
 *  display showed it). Few and larger: 48 × ~80 KB. */
const covers = new DiskCache<string>("recentcover", 48);
const COVER = 640;
const FETCH_MS = 8000;
const inflight = new Set<string>();
let onCaptured: ((key: string) => void) | null = null;

export const recentArtKey = (e: Pick<RecentTrack, "title" | "artist" | "album">): string =>
  playKey(e.title, e.artist, e.album);

/** Whose art dies with the session: a titled, non-radio play from any source
 *  but the library. */
const transient = (e: RecentTrack): boolean =>
  !e.isRadio && e.sourceId !== "MEDIA_PLAYER" && !!e.title && !!e.artUrl;

export function recentArtGet(key: string): string | null {
  return cache.get(key) ?? null;
}

/** The hero-size copy, when the capture landed while the URL lived. */
export function recentCoverGet(key: string): string | null {
  return covers.get(key) ?? null;
}

export function setRecentArtNotifier(fn: (key: string) => void): void {
  onCaptured = fn;
}

/** Capture a log entry's art while its URL is alive (no-op for durable art,
 *  a known key, or a capture already in flight). Failures leave the icon. */
export function captureRecentArt(e: RecentTrack): void {
  if (!transient(e)) return;
  const key = recentArtKey(e);
  if ((cache.has(key) && covers.has(key)) || inflight.has(key)) return;
  inflight.add(key);
  void (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
      const res = await fetch(e.artUrl as string, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) {
        // a retired id: the streamer serves only the current track's cover and
        // answers 400 (or 500) for any earlier one. Expected in the ordinary
        // course of a session (the first frame of a new AirPlay track names the
        // previous cover), so not a warning; the row keeps its icon and a later
        // frame's URL gets its own capture.
        return;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > 8 * 1024 * 1024) return;
      const img = nativeImage.createFromBuffer(buf);
      if (img.isEmpty()) return; // a format nativeImage cannot read (SVG)
      const { width } = img.getSize();
      const shown = width > THUMB ? img.resize({ width: THUMB, quality: "good" }) : img;
      cache.set(key, `data:image/jpeg;base64,${shown.toJPEG(82).toString("base64")}`);
      const cover = width > COVER ? img.resize({ width: COVER, quality: "good" }) : img;
      covers.set(key, `data:image/jpeg;base64,${cover.toJPEG(85).toString("base64")}`);
      onCaptured?.(key);
    } catch (err) {
      // a dead or slow URL: the row keeps its icon
      console.warn(`[recentart] capture failed for ${e.artUrl}: ${String(err)}`);
    } finally {
      inflight.delete(key);
    }
  })();
}

/** The log for the renderer: a transient entry whose picture was captured
 *  carries the durable copy in place of the streamer's URL. */
export function decorateRecents(list: RecentTrack[]): RecentTrack[] {
  return list.map((e) => {
    if (e.isRadio || e.sourceId === "MEDIA_PLAYER" || !e.title) return e;
    const d = cache.get(recentArtKey(e));
    return d ? { ...e, artUrl: d } : e;
  });
}
