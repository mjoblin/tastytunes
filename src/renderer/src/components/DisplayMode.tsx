import { useEffect, useRef, useState } from 'react'
import { Disc3, MicVocal, RadioTower, X } from 'lucide-react'
import { tt } from '@/api'
import { useStore } from '@/store'
import { usePlayhead } from '@/hooks/usePlayhead'
import { useLyrics } from '@/hooks/useLyrics'
import { cx, deriveNowPlaying } from '@/lib/format'

/**
 * Full-screen "display mode" (Roon display mode / Volumio now-playing kiosk):
 * chrome-free art + metadata for a desk or wall screen. Toggled with F; the
 * cursor and close control fade out after a few idle seconds.
 */
export function DisplayMode(): React.JSX.Element {
  const playState = useStore((s) => s.playState)
  const nowPlaying = useStore((s) => s.nowPlaying)
  const setDisplayMode = useStore((s) => s.setDisplayMode)
  const settings = useStore((s) => s.settings)
  const setSettings = useStore((s) => s.setSettings)
  const { position, duration } = usePlayhead()
  const [cursorIdle, setCursorIdle] = useState(false)
  const [clock, setClock] = useState(() => timeNow())
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const meta = deriveNowPlaying(playState, nowPlaying)

  // Enter OS fullscreen while mounted; leave on unmount. If the user exits
  // fullscreen (Esc), close display mode too.
  useEffect(() => {
    void document.documentElement.requestFullscreen?.().catch(() => {})
    const onChange = (): void => {
      if (!document.fullscreenElement) setDisplayMode(false)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    }
  }, [setDisplayMode])

  useEffect(() => {
    const timer = setInterval(() => setClock(timeNow()), 10_000)
    return () => clearInterval(timer)
  }, [])

  const onMouseMove = (): void => {
    setCursorIdle(false)
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(() => setCursorIdle(true), 3000)
  }

  const lyricsToggleable = settings.lyrics && !meta.isRadio && !!meta.subtitle
  const toggleLyrics = async (): Promise<void> => {
    const next = await tt.setSettings({ displayLyrics: !settings.displayLyrics })
    setSettings(next)
  }

  return (
    <div
      className={cx('fixed inset-0 z-40 bg-bg overflow-hidden', cursorIdle && 'cursor-hidden')}
      onMouseMove={onMouseMove}
    >
      {meta.artUrl && (
        <div
          aria-hidden
          className="absolute inset-0 bg-center bg-cover scale-125 blur-[110px] opacity-25 saturate-150"
          style={{ backgroundImage: `url(${meta.artUrl})` }}
        />
      )}

      <div
        className={cx(
          'absolute bottom-6 right-7 font-mono text-[13px] text-dim transition-opacity',
          cursorIdle && 'opacity-60'
        )}
      >
        {clock}
      </div>

      {/* top-RIGHT: the top-left corner belongs to macOS's (hidden but still
          click-swallowing) traffic-light zone in frameless windows */}
      {lyricsToggleable && (
        <button
          onClick={() => void toggleLyrics()}
          title={settings.displayLyrics ? 'Hide lyrics' : 'Show lyrics'}
          className={cx(
            'absolute top-4 right-16 z-20 p-2 rounded-full hover:bg-veil2 transition-opacity',
            settings.displayLyrics ? 'text-gold' : 'text-dim hover:text-ink',
            cursorIdle ? 'opacity-0' : 'opacity-100'
          )}
        >
          <MicVocal size={18} />
        </button>
      )}
      <button
        onClick={() => setDisplayMode(false)}
        title="Exit display mode (F)"
        className={cx(
          'absolute top-4 right-4 z-20 p-2 rounded-full text-dim hover:text-ink hover:bg-veil2 transition-opacity',
          cursorIdle ? 'opacity-0' : 'opacity-100'
        )}
      >
        <X size={18} />
      </button>

      {lyricsToggleable && settings.displayLyrics && <DisplayLyric />}

      <div className="relative h-full flex flex-col items-center justify-center gap-9 px-16">
        {meta.artUrl ? (
          <img
            src={meta.artUrl}
            alt=""
            className="w-[46vmin] h-[46vmin] object-cover rounded-2xl art-glow"
          />
        ) : (
          <div className="w-[46vmin] h-[46vmin] rounded-2xl bg-raised ring-1 ring-edge flex items-center justify-center">
            {meta.isRadio ? (
              <RadioTower size={90} strokeWidth={1} className="text-faint" />
            ) : (
              <Disc3 size={90} strokeWidth={1} className="text-faint" />
            )}
          </div>
        )}

        <div className="text-center max-w-[70vw] space-y-2.5">
          <div className="font-display font-bold text-[clamp(26px,4.5vmin,52px)] leading-tight tracking-tight text-balance">
            {meta.title ?? 'Nothing playing'}
          </div>
          {meta.subtitle && (
            <div className="text-[clamp(15px,2.2vmin,24px)] text-dim truncate">{meta.subtitle}</div>
          )}
          {meta.badges.length > 0 && (
            <div className="flex justify-center flex-wrap gap-1.5 pt-1.5">
              {meta.badges.map((b) => (
                <span key={b} className="badge">
                  {b}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {duration != null && duration > 0 && (
        <div className="absolute inset-x-0 bottom-0 h-[3px] bg-veil2">
          <div
            className="h-full bg-amber transition-[width] duration-300 ease-linear"
            style={{ width: `${Math.min(100, (position / duration) * 100)}%` }}
          />
        </div>
      )}
    </div>
  )
}

/**
 * The current synced line, floating above the progress bar. Absolutely
 * positioned and pointer-transparent: it never nudges the centered art/text
 * column, whatever it does. Dim ♪ through LRC gaps/intros (same as the
 * Now Playing inline line); renders nothing without synced lyrics.
 */
function DisplayLyric(): React.JSX.Element | null {
  const { synced, currentIndex } = useLyrics()
  if (!synced) return null
  const line = currentIndex >= 0 ? synced[currentIndex].text : ''
  return (
    <div className="absolute inset-x-0 bottom-10 px-16 text-center pointer-events-none">
      <div
        className={cx(
          'font-display text-[clamp(17px,2.8vmin,30px)] leading-snug line-clamp-2 text-balance',
          line ? 'text-gold/90' : 'text-faint'
        )}
      >
        {line || '♪'}
      </div>
    </div>
  )
}

function timeNow(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
