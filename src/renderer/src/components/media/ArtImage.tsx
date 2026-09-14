import { useEffect, useRef, useState } from "react";
import { cx } from "@/lib/format";
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
/** How long a pending picture waits before the well shimmers (a cached one never does). */
const SLOW_MS = 300;

const retriable = (url: string): boolean => /^https?:/i.test(url);
const bust = (url: string, n: number): string =>
  n > 0 && retriable(url) ? `${url}${url.includes("?") ? "&" : "?"}tt_retry=${n}` : url;

export function ArtImage({
  src,
  fallback,
  fallbackArt,
  className = "h-full w-full object-cover",
  lazy = false,
  shimmer = false,
}: {
  src: string | null | undefined;
  fallback: React.ReactNode;
  fallbackArt?: { artist: string | null | undefined; album: string | null | undefined };
  className?: string;
  lazy?: boolean;
  /**
   * A thin line glides along the well's bottom edge while a slow picture is on
   * its way (2026-09-14, with the thumbnail cache: a first draw from the
   * streamer's USB server takes most of a second). Opt-in for the cards, the
   * album header and the card-size art tiles, never the
   * display-mode crossfade; it starts only after SLOW_MS in view, so a cached
   * or fast picture never shimmers, and a picture the well waited for eases
   * in when it lands (a quick one is simply there).
   * IN VIEW matters for the lazy cards: a card below the fold is not asked for
   * until it nears the viewport, and a wait counted from mount would have every
   * scrolled-to card flash the band before its cached picture landed.
   */
  shimmer?: boolean;
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  /** The src that landed after the wait: only that one eases in; a quick one is simply there. */
  const [eased, setEased] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!shimmer || !src || loaded === src) {
      setSlow(false);
      return;
    }
    let t: ReturnType<typeof setTimeout> | null = null;
    const start = (): void => {
      if (t == null) t = setTimeout(() => setSlow(true), SLOW_MS);
    };
    const el = imgRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      start();
      return () => {
        if (t) clearTimeout(t);
      };
    }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        start();
        io.disconnect();
      }
    });
    io.observe(el);
    return () => {
      io.disconnect();
      if (t) clearTimeout(t);
    };
  }, [shimmer, src, loaded]);
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
    <>
      <img
        ref={imgRef}
        src={shown}
        alt=""
        loading={lazy ? "lazy" : undefined}
        className={cx(className, shimmer && eased === src && "art-in")}
        onLoad={() => {
          if (base === src) {
            // ease in only a picture the well waited for; one from the cache is
            // just there, as it would be with no indicator at all (user, 2026-09-14:
            // the header's picture looked as if it loaded again after its card)
            if (slow) setEased(src);
            setLoaded(src);
          }
        }}
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
      {shimmer && slow && loaded !== src && <span className="art-shimmer" aria-hidden />}
    </>
  );
}
