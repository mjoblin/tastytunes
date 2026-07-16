import { Disc3, Maximize2, MicVocal, RadioTower } from 'lucide-react'
import { useStore } from '@/store'
import { cx, deriveNowPlaying } from '@/lib/format'
import { SignalLamp } from '@/components/SignalLamp'
import { LyricsPanel } from '@/components/LyricsPanel'

const ALIGN_H = { left: 'justify-start', center: 'justify-center', right: 'justify-end' } as const
const ALIGN_V = { top: 'items-start', center: 'items-center', bottom: 'items-end' } as const

export function NowPlayingScreen(): React.JSX.Element {
  const playState = useStore((s) => s.playState)
  const nowPlaying = useStore((s) => s.nowPlaying)
  const setDisplayMode = useStore((s) => s.setDisplayMode)
  const lyricsOpen = useStore((s) => s.lyricsOpen)
  const setLyricsOpen = useStore((s) => s.setLyricsOpen)
  const { nowPlayingAlignH, nowPlayingAlignV, lyrics: lyricsEnabled } = useStore((s) => s.settings)
  const meta = deriveNowPlaying(playState, nowPlaying)

  // Lyrics need real track metadata — hidden for radio and title-only sources.
  const lyricsAvailable = lyricsEnabled && !meta.isRadio && !!meta.title && !!meta.subtitle

  const sourceName = nowPlaying?.source?.name ?? null
  const queueIndex = playState?.queue_index
  const queueLength = playState?.queue_length
  const state = playState?.state

  const empty = !meta.title && !meta.subtitle

  // Titleless top band: preserves the header's vertical rhythm (and houses the
  // display-mode button) so the art/text sit where they did with a title.
  const header = (
    <header className="drag-region flex items-center justify-end px-8 pt-8 pb-4 min-h-[83px]">
      {lyricsAvailable && (
        <button
          onClick={() => setLyricsOpen(!lyricsOpen)}
          title="Lyrics"
          className={cx(
            'no-drag p-2 rounded-md transition-colors',
            lyricsOpen ? 'text-gold' : 'text-faint hover:text-dim'
          )}
        >
          <MicVocal size={16} />
        </button>
      )}
      <button
        onClick={() => setDisplayMode(true)}
        title="Full-screen display mode (F)"
        className="no-drag p-2 rounded-md text-faint hover:text-dim transition-colors"
      >
        <Maximize2 size={16} />
      </button>
    </header>
  )

  if (empty) {
    return (
      <div className="h-full flex flex-col">
        {header}
        <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center px-8">
          <Disc3 size={56} strokeWidth={1} className="text-faint/50" />
          <div className="font-display text-2xl text-dim">Nothing playing</div>
          <div className="text-[13px] text-faint max-w-sm">
            Start playback from a queue, recall a preset, or stream to the device from another app.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="relative h-full overflow-hidden flex flex-col">
      {/* ambient art backdrop is rendered app-wide by AmbientBackdrop in App */}
      {header}

      {lyricsAvailable && lyricsOpen && <LyricsPanel />}

      {/* fixed alignment (settings-chosen) so the layout doesn't shift as track lengths change */}
      <div
        className={cx(
          'relative flex-1 min-h-0 flex gap-8 px-8 pb-10',
          ALIGN_H[nowPlayingAlignH],
          ALIGN_V[nowPlayingAlignV]
        )}
      >
        <div className="shrink-0">
          {meta.artUrl ? (
            <img
              src={meta.artUrl}
              alt=""
              className="w-[340px] h-[340px] xl:w-[400px] xl:h-[400px] object-cover rounded-2xl art-glow"
            />
          ) : (
            <div className="w-[340px] h-[340px] xl:w-[400px] xl:h-[400px] rounded-2xl bg-raised ring-1 ring-edge flex items-center justify-center">
              {meta.isRadio ? (
                <RadioTower size={72} strokeWidth={1} className="text-faint" />
              ) : (
                <Disc3 size={72} strokeWidth={1} className="text-faint" />
              )}
            </div>
          )}
        </div>

        <div className="min-w-0 max-w-xl space-y-5">
          <div className="flex items-center gap-3">
            {sourceName && <span className="badge">{sourceName}</span>}
            {state && state !== 'play' && (
              <span className={cx('microlabel', state === 'pause' ? 'text-amber' : '')}>
                {state === 'pause' ? 'paused' : state}
              </span>
            )}
          </div>

          <div className="space-y-1">
            <h1 className="font-display font-bold text-[clamp(28px,4vw,46px)] leading-[1.08] tracking-tight text-balance">
              {meta.title}
            </h1>
            {meta.subtitle && <div className="text-lg text-ink/80 truncate">{meta.subtitle}</div>}
            {meta.album && <div className="text-[14px] text-dim truncate">{meta.album}</div>}
          </div>

          {meta.badges.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {meta.badges.map((b) => (
                <span key={b} className="badge">
                  {b}
                </span>
              ))}
              <SignalLamp />
            </div>
          )}

          {meta.isRadio && nowPlaying?.display?.line3 && (
            <div className="text-[13px] text-dim">{nowPlaying.display.line3}</div>
          )}

          {queueIndex != null && queueLength != null && queueLength > 0 && (
            <div className="microlabel">
              track {queueIndex + 1} of {queueLength}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
