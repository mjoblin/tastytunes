import { useEffect, useState } from "react";

/**
 * True unless `url` is known to be unloadable (stale streamer art URLs can
 * 404). Probes with a detached Image — the browser dedupes against the same
 * URL loading in an <img> — and keys the failure to the exact URL, so a
 * track change retries automatically. Used to keep the ambient/display-mode
 * backdrops (CSS background-image, which fails silently) in step with the
 * ArtImage fallbacks. Like ArtImage, a failure is probed twice more, a beat
 * apart, before it is believed: the streamer's HTTP server can refuse a
 * connection in the startup burst (2026-09-06).
 */
const RETRY_DELAYS_MS = [1500, 4000];

export function useArtLoadable(url: string | null): boolean {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const probe = (attempt: number): void => {
      const img = new Image();
      img.onerror = () => {
        if (cancelled) return;
        if (attempt < RETRY_DELAYS_MS.length && /^https?:/i.test(url)) {
          timer = setTimeout(() => probe(attempt + 1), RETRY_DELAYS_MS[attempt]);
          return;
        }
        setFailedUrl(url);
      };
      img.src = attempt > 0 ? `${url}${url.includes("?") ? "&" : "?"}tt_retry=${attempt}` : url;
    };
    probe(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [url]);
  return url == null || failedUrl !== url;
}
