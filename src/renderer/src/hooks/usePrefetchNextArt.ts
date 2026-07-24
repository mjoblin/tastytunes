import { useEffect } from 'react'
import { useStore } from '@/store'

/**
 * Warms the NEXT queued track's artwork while the current one plays, so the
 * swap at the track boundary is instant instead of a live fetch.
 *
 * This is the case that hurts: an album keeps one cover for its whole run, but
 * a preset of mixed tracks (or any playlist) changes art every track, and art
 * proxied from a remote service can take the better part of a second. We
 * already know where the queue is going — `/queue/list` carries each item's
 * art_url — so there's no reason to start the fetch only once the track flips.
 *
 * Cast sources (AirPlay) have no queue, so they can't be warmed; they fall back
 * to useDecodedArt holding the previous cover until the new one lands, which
 * costs a beat of staleness instead of a blank window.
 */
export function usePrefetchNextArt(): void {
  const items = useStore((s) => s.queue?.items)
  const index = useStore((s) => s.playState?.queue_index)

  useEffect(() => {
    if (index == null || !items?.length) return
    // `position` is the streamer's own ordering; fall back to array order for
    // partial pages that don't carry it.
    const next =
      items.find((i) => i.position === index + 1) ??
      (items[index + 1] as (typeof items)[number] | undefined)
    const url = next?.metadata?.art_url
    if (!url) return
    // Detached probe — the browser cache is what the <img>/background-image
    // hits later, so this is the whole mechanism.
    const probe = new Image()
    probe.src = url
    return () => {
      probe.src = ''
    }
  }, [items, index])
}
