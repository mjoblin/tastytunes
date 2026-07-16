import { useEffect, useMemo, useState } from 'react'
import type { LyricsResult } from '@shared/ipc'
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
} {
  const playState = useStore((s) => s.playState)
  const nowPlaying = useStore((s) => s.nowPlaying)
  const playhead = useStore((s) => s.playhead)

  const meta = deriveNowPlaying(playState, nowPlaying)
  const duration = playState?.metadata?.duration ?? null
  const artist = meta.isRadio ? null : meta.subtitle
  const hasQuery = !!artist && !!meta.title
  const trackKey = `${artist}|${meta.title}|${meta.album}|${duration}`

  const [status, setStatus] = useState<LyricsStatus>('loading')
  const [result, setResult] = useState<LyricsResult | null>(null)

  useEffect(() => {
    if (!artist || !meta.title) {
      setStatus('none')
      setResult(null)
      return
    }
    let stale = false
    setStatus('loading')
    void tt
      .fetchLyrics({ artist, title: meta.title, album: meta.album, duration })
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- trackKey covers the query fields
  }, [trackKey])

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

  return { status, result, synced, currentIndex, isRadio: meta.isRadio, hasQuery }
}
