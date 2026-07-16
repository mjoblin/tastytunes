import { X } from 'lucide-react'
import { tt } from '@/api'
import { useStore } from '@/store'
import { useLyrics } from '@/hooks/useLyrics'

/**
 * The inline lyrics flavor: just the current synced line, under the track
 * details on Now Playing. Renders nothing without synced lyrics, and the
 * screen hides it entirely while the full panel is open. The hover ✕ turns
 * it off (persisted; Settings → Behavior brings it back).
 */
export function LyricLine(): React.JSX.Element | null {
  const setSettings = useStore((s) => s.setSettings)
  const { synced, currentIndex } = useLyrics()

  if (!synced) return null
  // LRC files carry empty-text timestamps for intros and instrumental gaps —
  // hold the line's place with a quiet ♪ instead of blinking out of existence.
  const line = currentIndex >= 0 ? synced[currentIndex].text : ''

  const hide = async (): Promise<void> => {
    const next = await tt.setSettings({ lyricsLine: false })
    setSettings(next)
  }

  return (
    <div className="group flex items-start gap-2 min-h-[28px] max-w-xl">
      {line ? (
        <div className="font-display text-[17px] leading-snug text-gold/90 line-clamp-2">
          {line}
        </div>
      ) : (
        <div className="font-display text-[17px] leading-snug text-faint">♪</div>
      )}
      <button
        onClick={() => void hide()}
        aria-label="Hide lyric line"
        data-tip="Hide lyric line"
        className="opacity-0 group-hover:opacity-100 p-1 mt-0.5 text-faint hover:text-dim transition-opacity shrink-0"
      >
        <X size={13} />
      </button>
    </div>
  )
}
