import { useEffect, useState } from 'react'

/**
 * True unless `url` is known to be unloadable (stale streamer art URLs can
 * 404). Probes with a detached Image — the browser dedupes against the same
 * URL loading in an <img> — and keys the failure to the exact URL, so a
 * track change retries automatically. Used to keep the ambient/display-mode
 * backdrops (CSS background-image, which fails silently) in step with the
 * ArtImage fallbacks.
 */
export function useArtLoadable(url: string | null): boolean {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!url) return
    let cancelled = false
    const probe = new Image()
    probe.onerror = () => {
      if (!cancelled) setFailedUrl(url)
    }
    probe.src = url
    return () => {
      cancelled = true
    }
  }, [url])
  return url == null || failedUrl !== url
}
