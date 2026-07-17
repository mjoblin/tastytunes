import { useState } from 'react'

/**
 * Artwork <img> that renders `fallback` when the URL is missing — or present
 * but unloadable (streamers can report stale art URLs that 404; a bare <img>
 * would show as an empty box with a broken-image glyph). Keying the failure
 * to the exact URL means a track change retries automatically.
 */
export function ArtImage({
  src,
  fallback,
  className = 'h-full w-full object-cover',
  lazy = false
}: {
  src: string | null | undefined
  fallback: React.ReactNode
  className?: string
  lazy?: boolean
}): React.JSX.Element {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  if (!src || failedSrc === src) return <>{fallback}</>
  return (
    <img
      src={src}
      alt=""
      loading={lazy ? 'lazy' : undefined}
      className={className}
      onError={() => setFailedSrc(src)}
    />
  )
}
