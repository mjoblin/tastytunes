import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LyricsResult } from '@shared/model'
import { tt } from '@/api'
import { useStore } from '@/store'
import { deriveNowPlaying } from '@/lib/format'

export interface SyncedLine {
  t: number
  text: string
}

export type LyricsStatus = 'loading' | 'ready' | 'none'

// "[mm:ss.xx] line" — repeated tags on one line share the text.
export function parseLrc(lrc: string): SyncedLine[] {
  const out: SyncedLine[] = []
  for (const raw of lrc.split('\n')) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)]
    if (tags.length === 0) continue
    const text = raw.replace(/\[\d+:\d+(?:\.\d+)?\]/g, '').trim()
    for (const m of tags) out.push({ t: Number(m[1]) * 60 + Number(m[2]), text })
  }
  return out.sort((a, b) => a.t - b.t)
}

/**
 * Two-phase crossfade for a changing text line: fade the old text out
 * (~180ms), swap, fade the new in. Pure opacity — the kind of fade the
 * reduced-motion pass deliberately keeps.
 */
export function useFadedText(text: string): { shown: string; visible: boolean } {
  const [shown, setShown] = useState(text)
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    if (text === shown) return
    // Hidden window: timers are throttled to a crawl (Chromium intensive
    // throttling) — the fade's "show again" step would lag by minutes and the
    // line would sit at opacity 0. Nobody's watching; swap instantly.
    if (document.hidden) {
      setShown(text)
      setVisible(true)
      return
    }
    setVisible(false)
    const t = setTimeout(() => {
      setShown(text)
      setVisible(true)
    }, 180)
    return () => clearTimeout(t)
  }, [text, shown])
  return { shown, visible }
}

/**
 * Lyrics for the current track (fetched via main, cached there), plus the
 * playhead-synced current line. Shared by the full panel and the inline line;
 * they never render together, so at most one instance ticks at a time.
 */
export function useLyrics(): {
  status: LyricsStatus
  result: LyricsResult | null
  synced: SyncedLine[] | null
  currentIndex: number
  isRadio: boolean
  hasQuery: boolean
  /** User-driven re-fetch that bypasses the main-process cache. */
  refresh(): void
} {
  const playState = useStore((s) => s.playState)
  const nowPlaying = useStore((s) => s.nowPlaying)
  const playhead = useStore((s) => s.playhead)

  const meta = deriveNowPlaying(playState, nowPlaying)
  const duration = playState?.metadata?.duration ?? null
  const artist = meta.isRadio ? null : meta.subtitle
  const hasQuery = !!artist && !!meta.title
  const trackKey = `${artist}|${meta.title}|${meta.album}|${duration}`

  // Track-change metadata arrives in STAGES (title first, duration a beat
  // later — live-proven). Fetching on the first twitch asked LRCLIB with the
  // PREVIOUS track's duration; the sync-trust window then rejects the true
  // record, and the degraded plain/miss result gets cached under a poisoned
  // key (193 such pairs found in one real cache). Let metadata settle before
  // asking — one query per track, with the duration that belongs to it.
  const [settled, setSettled] = useState(() => ({
    key: trackKey,
    query: artist && meta.title ? { artist, title: meta.title, album: meta.album, duration } : null
  }))
  useEffect(() => {
    if (settled.key === trackKey) return
    const t = setTimeout(
      () =>
        setSettled({
          key: trackKey,
          query: artist && meta.title ? { artist, title: meta.title, album: meta.album, duration } : null
        }),
      750
    )
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- trackKey covers the query fields
  }, [trackKey, settled.key])

  const [status, setStatus] = useState<LyricsStatus>('loading')
  const [result, setResult] = useState<LyricsResult | null>(null)
  const [fetchNonce, setFetchNonce] = useState(0)
  const forceRef = useRef(false)

  useEffect(() => {
    if (!settled.query) {
      setStatus('none')
      setResult(null)
      return
    }
    const force = forceRef.current
    forceRef.current = false
    let stale = false
    setStatus('loading')
    void tt
      .fetchLyrics(settled.query, force)
      .then((res) => {
        if (stale) return
        setResult(res)
        setStatus(res && (res.plain || res.synced || res.instrumental) ? 'ready' : 'none')
      })
      // e.g. IPC failure (stale main process without the handler) — anything
      // unexpected degrades to "no lyrics" instead of an eternal "Looking up…".
      .catch(() => {
        if (!stale) setStatus('none')
      })
    return () => {
      stale = true
    }
  }, [settled, fetchNonce])

  const refresh = useCallback(() => {
    forceRef.current = true
    setFetchNonce((n) => n + 1)
  }, [])

  const synced = useMemo(() => (result?.synced ? parseLrc(result.synced) : null), [result])

  // Interpolated playhead, ticking only while synced lyrics are on screen.
  const [positionSecs, setPositionSecs] = useState<number | null>(null)
  const playing = playState?.state === 'play'
  useEffect(() => {
    if (!synced) return
    const tick = (): void => {
      if (playhead == null) {
        setPositionSecs(null)
        return
      }
      setPositionSecs(playing ? playhead.secs + (Date.now() - playhead.at) / 1000 : playhead.secs)
    }
    tick()
    const timer = setInterval(tick, 400)
    return () => clearInterval(timer)
  }, [synced, playhead, playing])

  const currentIndex = useMemo(() => {
    if (!synced || positionSecs == null) return -1
    let idx = -1
    for (let i = 0; i < synced.length; i++) {
      if (synced[i].t <= positionSecs) idx = i
      else break
    }
    return idx
  }, [synced, positionSecs])

  // While the settle timer runs, the previous track's lyrics are stale —
  // report loading (and hand the panel no lines) rather than showing them.
  const settling = settled.key !== trackKey
  return {
    status: settling ? 'loading' : status,
    result: settling ? null : result,
    synced: settling ? null : synced,
    currentIndex: settling ? -1 : currentIndex,
    isRadio: meta.isRadio,
    hasQuery,
    refresh
  }
}
