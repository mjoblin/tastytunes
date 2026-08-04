import { useEffect, useState } from 'react'
import { tt } from '@/api'

/**
 * The ambient wash's art, BLURRED ONCE INTO A SMALL BITMAP instead of blurred
 * live by the compositor every frame.
 *
 * WHY THIS EXISTS (measured 2026-08-03, after a Windows VM made the app
 * unusable). The wash used to be a full-window layer wearing
 * `filter: blur(100px)`. On a GPU that is free; under SOFTWARE
 * RASTERIZATION — weak or blacklisted GPUs, RDP/Citrix, VMs — it cost
 * 227ms per repaint against 14ms with the wash off. Sixteen times. Clicks
 * took seconds and the equaliser bars crawled.
 *
 * WHAT THE NUMBERS RULED OUT, so nobody re-litigates it:
 *  - shrinking the RADIUS is not enough: blur(25px) still cost 7.4x and
 *    even blur(6px) cost 5.3x;
 *  - blurring a SMALL surface and scaling it up does nothing (15.6x) —
 *    Chromium rasterizes the layer at its final on-screen scale, so the
 *    kernel runs over the same million pixels either way;
 *  - it is not the blur specifically: `saturate()` ALONE cost 3.2x. Any
 *    per-frame filter over a full-window layer is the problem.
 *  - no filter at all: 2x (28ms), which is fine.
 * So the filter has to go, and the blur has to be baked into the pixels.
 *
 * HOW: fetch the art through the main process (it answers with a data URL —
 * the same door `useArtAccent` uses, and the reason the canvas isn't
 * CORS-tainted), draw it small with the canvas's own blur, and hand back a
 * ~160px pre-blurred bitmap. The layer that renders it carries no filter at
 * all. One canvas pass per track change replaces a filter pass per frame,
 * and it helps EVERY machine rather than only the ones we could detect.
 */
const cache = new Map<string, string | null>()

export function useBlurredArt(src: string | null | undefined): string | null {
  const [out, setOut] = useState<string | null>(() => (src ? (cache.get(src) ?? null) : null))

  useEffect(() => {
    if (!src) {
      setOut(null)
      return
    }
    if (cache.has(src)) {
      setOut(cache.get(src) ?? null)
      return
    }
    let cancelled = false
    void (async () => {
      let blurred: string | null = null
      try {
        const art = await tt.fetchArt(src)
        if (art) blurred = await bake(art.dataUrl)
      } catch {
        blurred = null
      }
      cache.set(src, blurred)
      // Bounded like the accent cache — a long listening session must not
      // accumulate a bitmap per track forever.
      if (cache.size > 60) cache.delete(cache.keys().next().value as string)
      if (!cancelled) setOut(blurred)
    })()
    return () => {
      cancelled = true
    }
  }, [src])

  return out
}

/**
 * Draw the cover into a small canvas through a real Gaussian blur. 160px is
 * chosen against the effect it replaces: a 100px blur over a ~1600px window
 * leaves roughly sixteen distinguishable features across, so a bitmap of this
 * order carries every bit of structure the old wash had. The saturate is baked
 * in for the same reason the blur is — a live `saturate()` cost 3.2x on its own.
 */
async function bake(dataUrl: string): Promise<string | null> {
  const img = new Image()
  img.src = dataUrl
  await img.decode()

  const size = 160
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  // Inset the draw so the blur has real pixels to pull from at the edges;
  // without it the kernel samples transparent black and the wash gets a dark
  // frame around it.
  ctx.filter = 'blur(14px) saturate(1.4)'
  const pad = Math.round(size * 0.22)
  ctx.drawImage(img, -pad, -pad, size + pad * 2, size + pad * 2)
  return canvas.toDataURL('image/jpeg', 0.7)
}
