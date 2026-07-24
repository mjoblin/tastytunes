import { useEffect, useRef, useState } from 'react'

/**
 * The blurred album-art wash behind the app (and behind the mini player's
 * strip). Two stacked layers CROSSFADE when the art changes, inside a wrapper
 * that owns the wash's opacity, blur and scale — so the dissolve can never
 * brighten past the wash's own level partway through, and one blur pass covers
 * both layers instead of two.
 *
 * Feed it DECODED art (useDecodedArt). A CSS background-image paints nothing
 * until its bytes arrive, so pointing this at a fresh URL the instant a track
 * changes dropped the whole window to base black for the length of the fetch —
 * very visible when the art comes from a remote service via the streamer.
 *
 * A null `src` fades the wash OUT rather than yanking it: art that fails to
 * load, or a disconnect, used to remove it in a single frame.
 */
export function AmbientArt({
  src,
  vignette
}: {
  src: string | null
  vignette: boolean
}): React.JSX.Element | null {
  const [cur, setCur] = useState<{ src: string | null; k: number }>({ src, k: 0 })
  const [prev, setPrev] = useState<{ src: string; k: number } | null>(null)
  const curRef = useRef(cur)
  const kRef = useRef(0)
  useEffect(() => {
    if (src === curRef.current.src) return
    const outgoing = curRef.current
    if (outgoing.src) setPrev({ src: outgoing.src, k: outgoing.k })
    const next = { src, k: ++kRef.current }
    curRef.current = next
    setCur(next)
  }, [src])

  if (!cur.src && !prev) return null
  return (
    <div aria-hidden className="absolute inset-0 overflow-hidden pointer-events-none">
      <div className="ambient-art">
        {prev && (
          <div
            key={`p${prev.k}`}
            className="ambient-layer ambient-layer-out"
            style={{ backgroundImage: `url(${prev.src})` }}
            onAnimationEnd={(e) => {
              if (e.target === e.currentTarget) setPrev(null)
            }}
          />
        )}
        {cur.src && (
          <div
            key={`c${cur.k}`}
            className="ambient-layer ambient-layer-in"
            style={{ backgroundImage: `url(${cur.src})` }}
          />
        )}
      </div>
      {vignette && <div className="ambient-vignette" />}
    </div>
  )
}
