import { useEffect, useRef, useState } from 'react'
import { MicVocal, RotateCw, X } from 'lucide-react'
import { tt } from '@/api'
import { useStore } from '@/store'
import { cx } from '@/lib/format'
import { useLyrics } from '@/hooks/useLyrics'

export function LyricsPanel(): React.JSX.Element {
  const setLyricsOpen = useStore((s) => s.setLyricsOpen)
  const { status, result, synced, currentIndex, isRadio, hasQuery, refresh } = useLyrics()

  // Keep the current line centered — but never while the pointer is inside the
  // panel: recentering mid-hover yanks the line you're about to click away.
  // Recenters again on pointer leave. Jump instead of glide under reduced motion.
  const [hovered, setHovered] = useState(false)
  const currentRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (hovered) return
    const reduce = document.documentElement.classList.contains('reduce-motion')
    currentRef.current?.scrollIntoView({
      block: 'center',
      behavior: reduce ? 'auto' : 'smooth'
    })
  }, [currentIndex, hovered])

  return (
    <aside className="no-drag absolute inset-y-0 right-0 z-10 w-[380px] max-w-[45%] flex flex-col bg-panel/60 backdrop-blur-md border-l border-edge">
      <div className="flex items-center justify-between px-6 pt-5 pb-3">
        <div className="microlabel flex items-center gap-2">
          <MicVocal size={13} />
          lyrics
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={refresh}
            aria-label="Refresh lyrics"
            data-tip="Refresh from LRCLIB"
            className="tip-bottom tip-end p-1.5 rounded-full text-faint hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all"
          >
            <RotateCw size={13} />
          </button>
          <button
            onClick={() => setLyricsOpen(false)}
            aria-label="Close lyrics"
            className="p-1.5 rounded-full text-faint hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      <div
        className="flex-1 min-h-0 overflow-y-auto px-6 pb-4"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {status === 'loading' && (
          <div className="text-[13px] text-faint pt-2">Retrieving lyrics…</div>
        )}

        {status === 'none' && (
          <div className="text-[13px] text-faint pt-2">
            {isRadio || !hasQuery
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
          className="microlabel inline-flex px-2.5 py-1.5 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-90 transition-all"
        >
          lyrics from lrclib.net
        </button>
      </div>
    </aside>
  )
}
