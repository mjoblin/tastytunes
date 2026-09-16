import { useEffect, useRef, useState } from "react";
import { useArtFallback } from "@/lib/artFallback";

/**
 * Artwork <img> that renders `fallback` when the URL is missing — or present
 * but unloadable (streamers can report stale art URLs that 404; a bare <img>
 * would show as an empty box with a broken-image glyph). Keying the failure
 * to the exact URL means a track change retries automatically.
 *
 * A FAILED LOAD IS RETRIED before it is believed (2026-09-06, user: the app
 * restarted while AirPlay played and the hero stayed an icon though the
 * streamer showed the cover). The streamer's small HTTP server takes the
 * startup burst — presets, queue, system info, and this same art URL asked
 * for by the capture, the accent and the picture at once — and one refused
 * connection used to hide the art for the whole song, since an AirPlay
 * track's URL never changes. Two retries, a beat apart, with a cache-busting
 * query so the browser does not hand back the failure; data URLs are never
 * retried. While a retry waits the FALLBACK shows, never the failed <img>:
 * Chromium paints a broken-image glyph on one (user, 2026-09-06).
 *
 * `fallbackArt` (an album's artist + title) tries the Cover Art Archive
 * before giving up on the icon: consulted ONLY when the server offered no
 * art or its URL failed — server art always wins. Off with the same switch
 * as the context lookups (main answers null when the toggle is off).
 */
const RETRY_DELAYS_MS = [1500, 4000];

const retriable = (url: string): boolean => /^https?:/i.test(url);
const bust = (url: string, n: number): string =>
  n > 0 && retriable(url) ? `${url}${url.includes("?") ? "&" : "?"}tt_retry=${n}` : url;

export function ArtImage({
  src,
  fallback,
  fallbackArt,
  className = "h-full w-full object-cover",
  lazy = false,
}: {
  src: string | null | undefined;
  fallback: React.ReactNode;
  fallbackArt?: { artist: string | null | undefined; album: string | null | undefined };
  className?: string;
  lazy?: boolean;
}): React.JSX.Element {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [retry, setRetry] = useState<{ src: string; n: number; waiting: boolean }>({
    src: "",
    n: 0,
    waiting: false,
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const attempt = src != null && retry.src === src ? retry.n : 0;
  const waiting = src != null && retry.src === src && retry.waiting;
  const missing = !src || failedSrc === src;
  const caa = useArtFallback(fallbackArt, missing && fallbackArt != null);
  const base = missing ? caa : src;
  if (!base || failedSrc === base || (waiting && base === src)) return <>{fallback}</>;
  const shown = base === src ? bust(base, attempt) : base;
  return (
    <img
      src={shown}
      alt=""
      loading={lazy ? "lazy" : undefined}
      className={className}
      onError={() => {
        if (base === src && retriable(base) && attempt < RETRY_DELAYS_MS.length) {
          if (timer.current) clearTimeout(timer.current);
          setRetry({ src: base, n: attempt, waiting: true });
          timer.current = setTimeout(
            () => setRetry({ src: base, n: attempt + 1, waiting: false }),
            RETRY_DELAYS_MS[attempt],
          );
          return;
        }
        if (base === src) console.warn("[art] gave up on", base);
        setFailedSrc(base);
      }}
    />
  );
}
