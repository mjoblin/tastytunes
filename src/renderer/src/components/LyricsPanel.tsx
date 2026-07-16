import { useEffect, useMemo, useRef, useState } from 'react'
import { MicVocal, X } from 'lucide-react'
import type { LyricsResult } from '@shared/ipc'
import { tt } from '@/api'
import { useStore } from '@/store'
import { cx, deriveNowPlaying } from '@/lib/format'

interface SyncedLine {
  t: number
  text: string
}

// "[mm:ss.xx] line" — repeated tags on one line share the text.
function parseLrc(lrc: string): SyncedLine[] {
  const out: SyncedLine[] = []
  for (const raw of lrc.split('\n')) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)]
    if (tags.length === 0) continue
    const text = raw.replace(/\[\d+:\d+(?:\.\d+)?\]/g, '').trim()
    for (const m of tags) out.push({ t: Number(m[1]) * 60 + Number(m[2]), text })
  }
  return out.sort((a, b) => a.t - b.t)
}

type Status = 'loading' | 'ready' | 'none'

export function LyricsPanel(): React.JSX.Element {
  const playState = useStore((s) => s.playState)
  const nowPlaying = useStore((s) => s.nowPlaying)
  const playhead = useStore((s) => s.playhead)
  const setLyricsOpen = useStore((s) => s.setLyricsOpen)

  const meta = deriveNowPlaying(playState, nowPlaying)
  const duration = playState?.metadata?.duration ?? null
  const artist = meta.isRadio ? null : meta.subtitle
  const trackKey = `${artist}|${meta.title}|${meta.album}|${duration}`

  const [status, setStatus] = useState<Status>('loading')
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
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- trackKey covers the query fields
  }, [trackKey])

  const synced = useMemo(() => (result?.synced ? parseLrc(result.synced) : null), [result])

  // Interpolated playhead, ticking only while the panel shows synced lyrics.
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

  // Keep the current line centered; jump instead of glide under reduced motion.
  const currentRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    const reduce = document.documentElement.classList.contains('reduce-motion')
    currentRef.current?.scrollIntoView({
      block: 'center',
      behavior: reduce ? 'auto' : 'smooth'
    })
  }, [currentIndex])

  return (
    <aside className="no-drag absolute inset-y-0 right-0 z-10 w-[380px] max-w-[45%] flex flex-col bg-panel/85 backdrop-blur-md border-l border-edge">
      <div className="flex items-center justify-between px-6 pt-5 pb-3">
        <div className="microlabel flex items-center gap-2">
          <MicVocal size={13} />
          lyrics
        </div>
        <button
          onClick={() => setLyricsOpen(false)}
          aria-label="Close lyrics"
          className="p-1 text-faint hover:text-dim transition-colors"
        >
          <X size={15} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-4">
        {status === 'loading' && <div className="text-[13px] text-faint pt-2">Looking up…</div>}

        {status === 'none' && (
          <div className="text-[13px] text-faint pt-2">
            {meta.isRadio || !artist
              ? 'Lyrics need track metadata — not available for this source.'
              : 'No lyrics found for this track.'}
          </div>
        )}

        {status === 'ready' && result?.instrumental && (
          <div className="text-[13px] text-faint pt-2">Instrumental.</div>
        )}

        {status === 'ready' && !result?.instrumental && synced && (
          <div className="space-y-0.5 py-2">
            {synced.map((line, i) => (
              <button
                key={`${line.t}-${i}`}
                ref={i === currentIndex ? currentRef : undefined}
                onClick={() => void tt.command({ type: 'seek', positionSecs: line.t })}
                title="Jump here"
                className={cx(
                  'block w-full text-left text-[14px] leading-relaxed rounded px-1.5 py-0.5 transition-colors',
                  i === currentIndex
                    ? 'text-gold font-medium'
                    : 'text-dim hover:text-ink hover:bg-veil'
                )}
              >
                {line.text || '♪'}
              </button>
            ))}
          </div>
        )}

        {status === 'ready' && !result?.instrumental && !synced && result?.plain && (
          <div className="whitespace-pre-wrap text-[14px] leading-relaxed text-dim py-2">
            {result.plain}
          </div>
        )}
      </div>

      <div className="px-6 py-3 border-t border-edge">
        <button
          onClick={() => void tt.openExternal('https://lrclib.net')}
          className="microlabel text-faint hover:text-dim transition-colors"
        >
          lyrics from lrclib.net
        </button>
      </div>
    </aside>
  )
}
