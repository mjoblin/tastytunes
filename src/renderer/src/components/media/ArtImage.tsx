import { useState } from "react";
import { useArtFallback } from "@/lib/artFallback";

/**
 * Artwork <img> that renders `fallback` when the URL is missing — or present
 * but unloadable (streamers can report stale art URLs that 404; a bare <img>
 * would show as an empty box with a broken-image glyph). Keying the failure
 * to the exact URL means a track change retries automatically.
 *
 * `fallbackArt` (an album's artist + title) tries the Cover Art Archive
 * before giving up on the icon: consulted ONLY when the server offered no
 * art or its URL failed — server art always wins. Off with the same switch
 * as the context lookups (main answers null when the toggle is off).
 */
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
  const missing = !src || failedSrc === src;
  const caa = useArtFallback(fallbackArt, missing && fallbackArt != null);
  const shown = missing ? caa : src;
  if (!shown || failedSrc === shown) return <>{fallback}</>;
  return (
    <img
      src={shown}
      alt=""
      loading={lazy ? "lazy" : undefined}
      className={className}
      onError={() => setFailedSrc(shown)}
    />
  );
}
