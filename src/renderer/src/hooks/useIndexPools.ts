import { useEffect, useMemo, useState } from 'react'
import type { MediaIndexPools } from '@shared/model'
import { tt } from '@/api'
import { useStore } from '@/store'

/**
 * The ready indexes' pools, cached on their builtAt signature: re-entry is
 * instant, a rebuild (new signature) refetches, and every caller in a window
 * shares ONE snapshot. Lived inside LibraryScreen until the queue rows needed
 * the same thing (2026-08-21, performers for compilation entries) — a second
 * surface asks where the app already computes a thing, not how to compute it.
 *
 * `enabled` defers the fetch until a surface actually needs the pools (the
 * Library fetches when a lens opens); the last snapshot stays available
 * either way.
 */
let poolsCache: { sig: string; pools: MediaIndexPools[] } | null = null

export function useIndexPools(enabled = true): MediaIndexPools[] | null {
  const statuses = useStore((s) => s.mediaIndex)
  const sig = useMemo(
    () =>
      statuses
        .filter((x) => x.state === 'ready')
        .map((x) => `${x.udn}:${x.builtAt}`)
        .sort()
        .join('|'),
    [statuses]
  )
  const [pools, setPools] = useState<MediaIndexPools[] | null>(() =>
    poolsCache?.sig === sig ? poolsCache.pools : null
  )
  useEffect(() => {
    if (!enabled) return
    if (poolsCache?.sig === sig) {
      setPools(poolsCache.pools)
      return
    }
    let stale = false
    void tt.mediaIndexPools().then((fetched) => {
      if (stale) return
      poolsCache = { sig, pools: fetched }
      setPools(fetched)
    })
    return () => {
      stale = true
    }
  }, [enabled, sig])
  return pools
}
