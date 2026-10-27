import { useEffect, useRef, useState } from "react";
import { cx } from "@/lib/format";
import { useArtFallback } from "@/lib/artFallback";
import { keepArt, shownBefore } from "@/lib/artKeep";

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

/**
 * A LAZY PICTURE UNDER A FADE PRELOADS AHEAD OF ITS OWN SCROLLER (0.12.0-rc.3). Chromium's own
 * lazy loading starts a picture 1,250px before it scrolls into view, looking past the scroller's
 * edge; a mask on the scroller or any ancestor (a fade-top, the Library's ring room) cuts that
 * look-ahead back to the visible box, and a server's album cards below the fold never loaded
 * until scrolled to (S84 caught it). So a lazy picture UNDER A MASK watches its nearest scroller
 * itself, with the same reach, and turns eager when it comes within it. Anywhere else Chromium's
 * own lazy loading is left alone, as it always was (the look-ahead everywhere was suspected in
 * his lenses' pictures not loading, 2026-10-22). One observer per scroller, shared by every
 * picture in it.
 */
const NEAR_MARGIN = "1250px 0px";
const nearObservers = new Map<
  Element | null,
  { io: IntersectionObserver; near: Map<Element, () => void> }
>();

/**
 * An ancestor's mask and overflow, read once a frame: a lens's pictures mount together and share
 * their ancestors, and reading each one's computed style once per picture made the Albums lens's
 * every opening take a second at 5,000 albums (0.13.0, the scale fixture: 1.0 of its 1.9 s).
 */
let frameStyles: Map<Element, { masked: boolean; scrolls: boolean }> | null = null;
function styleOf(el: Element): { masked: boolean; scrolls: boolean } {
  if (!frameStyles) {
    frameStyles = new Map();
    requestAnimationFrame(() => {
      frameStyles = null;
    });
  }
  let s = frameStyles.get(el);
  if (!s) {
    const cs = getComputedStyle(el);
    s = {
      masked:
        (cs.maskImage !== "none" && cs.maskImage !== "") ||
        (cs.webkitMaskImage !== "none" && cs.webkitMaskImage !== ""),
      scrolls: /(auto|scroll)/.test(cs.overflowY),
    };
    frameStyles.set(el, s);
  }
  return s;
}

function scrollerOf(el: Element): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) if (styleOf(p).scrolls) return p;
  return null;
}

/** Whether a mask sits on the picture's way up to the page (a fade cuts the look-ahead). */
function underMask(el: Element): boolean {
  for (let p = el.parentElement; p; p = p.parentElement) if (styleOf(p).masked) return true;
  return false;
}

function watchNear(el: Element, onNear: () => void): () => void {
  if (!underMask(el)) return () => {};
  const root = scrollerOf(el);
  let entry = nearObservers.get(root);
  if (!entry) {
    const near = new Map<Element, () => void>();
    const io = new IntersectionObserver(
      (es) => {
        for (const e of es) {
          if (!e.isIntersecting) continue;
          near.get(e.target)?.();
        }
      },
      { root, rootMargin: NEAR_MARGIN },
    );
    entry = { io, near };
    nearObservers.set(root, entry);
  }
  const { io, near } = entry;
  near.set(el, onNear);
  io.observe(el);
  return () => {
    io.unobserve(el);
    near.delete(el);
    if (near.size === 0) {
      io.disconnect();
      nearObservers.delete(root);
    }
  };
}

/** Where a picture taller than it is wide is cropped to the square (0.11.0, his Madonna: the top
 *  of her head cut off): artists' photos are mostly portraits with the head in the top third,
 *  and a centered crop takes as much off the top as the bottom. */
export const PORTRAIT_POSITION = "50% 20%";
/** Taller than wide by more than a rounding error. */
export const isPortrait = (w: number, h: number): boolean => w > 0 && h > w * 1.02;

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
  portraitTop = false,
  onGiveUp,
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
  /** Crop a portrait picture from near its top rather than its middle (PORTRAIT_POSITION): an
   *  artist's photo. A square picture, every album cover, is drawn as before. */
  portraitTop?: boolean;
  /** Told when the picture at `src` has failed for good (after its retries), so a caller with
   *  another way to the picture can take it (MediaArt's library fallback). */
  onGiveUp?: () => void;
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  /** The src that landed after the wait: only that one eases in; a quick one is simply there. */
  const [eased, setEased] = useState<string | null>(null);
  /** The shown src that loaded taller than wide (for portraitTop). */
  const [tall, setTall] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  // a lazy picture turns eager once its own scroller brings it within reach (above)
  const [near, setNear] = useState(false);
  useEffect(() => {
    // a picture shown before this session comes back from memory or main's disk cache: no loader
    if (!shimmer || !src || loaded === src || shownBefore(src)) {
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
  const drawn = !!base && failedSrc !== base && !(waiting && base === src);
  useEffect(() => {
    const el = imgRef.current;
    if (!lazy || near || !drawn || !el || typeof IntersectionObserver === "undefined") return;
    return watchNear(el, () => setNear(true));
  }, [lazy, near, drawn, base]);
  if (!drawn) return <>{fallback}</>;
  const shown = base === src ? bust(base, attempt) : base;
  return (
    <>
      <img
        ref={imgRef}
        src={shown}
        alt=""
        // pending from the first frame until the picture lands: a well can read it
        // (the album header's ring steps up on it, without the line's 300 ms wait)
        data-art-pending={loaded === src ? undefined : ""}
        loading={lazy && !near ? "lazy" : undefined}
        className={cx(className, shimmer && eased === src && "art-in")}
        style={portraitTop && tall === shown ? { objectPosition: PORTRAIT_POSITION } : undefined}
        onLoad={(e) => {
          if (portraitTop) {
            const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
            setTall(isPortrait(w, h) ? shown : null);
          }
          if (base === src) {
            // ease in only a picture the well waited for; one from the cache is
            // just there, as it would be with no indicator at all (user, 2026-09-14:
            // the header's picture looked as if it loaded again after its card)
            if (slow) setEased(src);
            setLoaded(src);
            // a card's picture stays in the window for when its card comes back (lib/artKeep)
            if (shimmer && attempt === 0) keepArt(src);
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
          if (base === src) {
            console.warn("[art] gave up on", base);
            onGiveUp?.();
          }
          setFailedSrc(base);
        }}
      />
      {shimmer && slow && loaded !== src && <span className="art-shimmer" aria-hidden />}
    </>
  );
}
