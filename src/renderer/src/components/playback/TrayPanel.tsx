import {
  Disc3,
  Heart,
  Loader2,
  Minus,
  Pause,
  Play,
  Plus,
  Power,
  RadioTower,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX
} from 'lucide-react'
import { isCbusMode, isPreAmpMode } from '@shared/smoip'
import { tt } from '@/api'
import { useStore } from '@/store'
import { usePlayhead } from '@/hooks/usePlayhead'
import { useArtAccent } from '@/hooks/useArtAccent'
import { useMotionPreference } from '@/hooks/useMotionPreference'
import { useTheme } from '@/hooks/useTheme'
import { useDisplayFont } from '@/hooks/useDisplayFont'
import { useDecodedArt } from '@/hooks/useDecodedArt'
import { useNowPlayingHeart } from '@/hooks/useNowPlayingHeart'
import { useVolumeSlider, useWheelVolume } from '@/components/playback/VolumeCluster'
import { Slider } from '@/components/controls/Slider'
import { ArtImage } from '@/components/media/ArtImage'
import { AmbientArt } from '@/components/media/AmbientArt'
import { controlSet, cx, deriveNowPlaying, fmtTime } from '@/lib/format'

/**
 * The tray panel (?tray=1): what's playing, reachable without a window.
 *
 * NOT A SECOND MINI PLAYER, and the difference is the reason both are allowed
 * to exist. The mini is PERSISTENT and PLACED — you position it once and leave
 * it sitting over your work. The panel is TRANSIENT and ANCHORED — it appears
 * under the tray icon, you do one thing, it dismisses on blur. Its
 * justification is reach without a window, not "small now playing".
 *
 * Phase 2 is this header plus the footer. Phase 3 adds the tab strip (Queue ·
 * Presets · Playlists · Recent) between them and grows the window.
 *
 * Everything here arrives through the same pushes the main window gets
 * (`deviceManager.push` fans out to every webContents) and follows theme, font
 * and ambient settings live (`broadcastSettings` hits every window) — which is
 * why this file is assembly rather than plumbing.
 */
export function TrayPanel(): React.JSX.Element {
  const connection = useStore((s) => s.connection)
  const playState = useStore((s) => s.playState)
  const nowPlaying = useStore((s) => s.nowPlaying)
  const zoneState = useStore((s) => s.zoneState)
  const systemPower = useStore((s) => s.systemPower)
  const systemInfo = useStore((s) => s.systemInfo)
  const settings = useStore((s) => s.settings)
  const { position, duration } = usePlayhead()
  const onWheel = useWheelVolume()
  // Unconditional, above any early return — the hook count must never shift.
  const vol = useVolumeSlider()
  const heart = useNowPlayingHeart()
  const theme = useTheme(settings.theme)
  useDisplayFont(settings.displayFont)
  useMotionPreference(settings.motion)

  const connected = connection.phase === 'connected'
  const powered = systemPower?.power === 'ON'
  const active = connected && powered
  const meta = deriveNowPlaying(playState, nowPlaying)
  const controls = controlSet(nowPlaying)
  useArtAccent(settings.accentFollowsArt && active ? meta.artUrl : null, theme)
  const { art } = useDecodedArt(meta.artUrl)

  const state = playState?.state
  // `active` matters: play_state survives a disconnect or a drop into standby,
  // so without it the disabled button sits there showing a PAUSE icon —
  // claiming the streamer is playing while the panel says nothing is.
  const playing = active && state === 'play'
  const busy = active && (state === 'buffering' || state === 'connecting')
  const canToggle = controls.has('play_pause') || controls.has('play') || controls.has('pause')
  const canNext = controls.has('track_next')
  const canPrev = controls.has('track_previous')

  const muted = zoneState?.mute === true
  const preAmp = isPreAmpMode(zoneState)
  const cbus = isCbusMode(zoneState)
  const hasVolume = zoneState != null && (preAmp || cbus)

  const timeText = active
    ? duration != null
      ? `${fmtTime(position)} / ${fmtTime(duration)}`
      : fmtTime(position)
    : ''

  // The footer's device line. A panel that hides the streamer's state lies
  // about it, so connection and standby are always readable here — and
  // wake-from-standby is genuinely menu-bar-shaped (it's midnight, the app
  // isn't open, the streamer is asleep).
  const deviceName = systemInfo?.name?.trim() || (connected ? connection.host : null)
  const deviceLine = !connected
    ? connection.phase === 'connecting'
      ? 'Connecting…'
      : 'Not connected'
    : powered
      ? (deviceName ?? 'Connected')
      : `${deviceName ?? 'Streamer'} · Standby`

  return (
    <div className="h-screen w-screen p-1" onWheel={onWheel}>
      <div className="relative h-full w-full rounded-2xl bg-panel ring-1 ring-edge2 overflow-hidden flex flex-col shadow-[0_18px_50px_rgb(0_0_0_/_0.55)]">
        {/* Same wash and the same gating as everywhere else: 'off' means off
            here too, and 'now-playing' keeps it, because this is nothing but
            a now-playing surface. */}
        <AmbientArt
          src={active && settings.ambientArt !== 'off' ? (art ?? null) : null}
          vignette={settings.vignette}
        />

        {/* ---- header: art, title/artist, heart, transport, volume ----
            The window is sized to fit this, honestly, rather than resizing
            itself to its content — that trick is a Tauri outside-click
            workaround, and in Electron blur does the dismissing. */}
        <div className="relative flex-1 flex flex-col px-4 pt-4 pb-3 gap-3.5">
          <div className="flex items-start gap-3">
            <div className="relative h-16 w-16 shrink-0 rounded-lg overflow-hidden bg-raised flex items-center justify-center">
              <ArtImage
                src={active ? art : null}
                fallback={
                  meta.isRadio && active ? (
                    <RadioTower size={24} className="text-faint" />
                  ) : (
                    <Disc3 size={24} className="text-faint" />
                  )
                }
              />
            </div>
            <div className="flex-1 min-w-0 pt-1">
              {/* min-heights keep both lines occupying space through the brief
                  metadata gap on a track change, so nothing shifts. */}
              <div className="font-display no-optical font-bold tracking-tight text-[14.5px] text-ink truncate leading-tight min-h-[17px]">
                {active ? (meta.title ?? ' ') : 'Nothing playing'}
              </div>
              {/* No "not connected" fallback here, unlike the mini player: the
                  panel has a footer that already says so, and the mini doesn't.
                  The line still reserves its height so nothing shifts. */}
              <div className="font-display no-optical tracking-tight text-[12.5px] text-dim truncate leading-tight mt-0.5 min-h-[15px]">
                {(active && meta.subtitle) || ' '}
              </div>
            </div>
            {/* The heart is the panel's one WRITE affordance, and the reason
                Favorites doesn't need to be a tab: favourite what you're
                hearing without opening anything.
                Gated on `active` as well as availability: play_state keeps its
                metadata through standby, so without this the panel says
                "Nothing playing" and offers to favourite it in the same
                breath. (Now Playing shows the last-played track deliberately
                in standby — a sleeping face, not an empty one — so it's right
                for the heart to stay there and wrong for it to stay here.) */}
            {active && heart.available && (
              <button
                aria-label={heart.active ? 'Remove from favorites' : 'Add to favorites'}
                data-tip={heart.active ? 'Remove from favorites' : 'Add to favorites'}
                onClick={heart.toggle}
                className={cx(
                  'tip-bottom tip-end shrink-0 p-1 rounded transition-colors',
                  heart.active ? 'text-gold' : 'text-faint hover:text-ink'
                )}
              >
                <Heart size={13} fill={heart.active ? 'currentColor' : 'none'} />
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <PanelButton enabled={active && canPrev} tip="Previous" onClick={() => void tt.command({ type: 'previousTrack' })}>
              <SkipBack size={15} />
            </PanelButton>
            <button
              data-tip={playing ? 'Pause' : 'Play'}
              aria-label={playing ? 'Pause' : 'Play'}
              disabled={!active || (!canToggle && !busy)}
              onClick={() => void tt.command({ type: 'togglePlayback' })}
              className={cx(
                'tip-top h-9 w-9 rounded-full flex items-center justify-center transition-all shrink-0',
                active && (canToggle || busy)
                  ? 'bg-gold text-bg motion-safe:hover:scale-105'
                  : 'bg-veil2 text-faint'
              )}
            >
              {busy ? (
                <Loader2 size={15} className="spin" />
              ) : playing ? (
                <Pause size={15} fill="currentColor" strokeWidth={0} />
              ) : (
                <Play size={15} fill="currentColor" strokeWidth={0} className="translate-x-[1px]" />
              )}
            </button>
            <PanelButton enabled={active && canNext} tip="Next" onClick={() => void tt.command({ type: 'nextTrack' })}>
              <SkipForward size={15} />
            </PanelButton>

            {active && hasVolume ? (
              <>
                <button
                  data-tip={muted ? 'Unmute — scroll for volume' : 'Mute — scroll for volume'}
                  aria-label={muted ? 'Unmute' : 'Mute'}
                  onClick={() => void tt.command({ type: 'setMute', mute: !muted })}
                  className={cx(
                    'tip-top p-1 ml-0.5 rounded transition-colors shrink-0',
                    muted ? 'text-gold' : 'text-dim hover:text-ink'
                  )}
                >
                  {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                </button>
                {preAmp ? (
                  // The panel is transient and never hovered "at rest", so the
                  // volume slider is always out — unlike the mini, which
                  // reveals it on hover because it sits on screen permanently
                  // and a bare slider would be visual noise all day.
                  <div className={cx('flex-1 min-w-0', muted && 'opacity-40')}>
                    <Slider
                      value={vol.value}
                      onScrub={vol.onScrub}
                      onCancel={vol.onCancel}
                      onCommit={vol.onCommit}
                      ariaLabel="Volume"
                    />
                  </div>
                ) : (
                  // Control Bus has no absolute level — nudges only.
                  <>
                    <PanelButton enabled tip="Volume down" onClick={() => void tt.command({ type: 'volumeStepChange', delta: -1 })}>
                      <Minus size={14} />
                    </PanelButton>
                    <PanelButton enabled tip="Volume up" onClick={() => void tt.command({ type: 'volumeStepChange', delta: 1 })}>
                      <Plus size={14} />
                    </PanelButton>
                    <div className="flex-1" />
                  </>
                )}
              </>
            ) : (
              <div className="flex-1" />
            )}
            <span className="font-mono text-[9.5px] text-faint tabular-nums shrink-0">{timeText}</span>
          </div>
        </div>

        {/* ---- footer: device state, and the way back to the app ----
            Power sits at the RIGHT, mirroring the playback bar's right cluster:
            a widget of a given type belongs in the same place on every surface
            that has one. */}
        <div className="relative flex items-center gap-2 px-3.5 h-9 border-t border-edge bg-bg/40">
          <button
            onClick={() => void tt.showMain()}
            className="text-[11.5px] text-dim hover:text-ink transition-colors truncate"
          >
            Open TastyTunes
          </button>
          <div className="flex-1" />
          <span className="text-[11px] text-faint truncate max-w-[170px]" title={deviceLine}>
            {deviceLine}
          </span>
          <button
            data-tip={powered ? 'Put in standby' : 'Wake'}
            aria-label={powered ? 'Put in standby' : 'Wake'}
            disabled={!connected}
            onClick={() => void tt.command({ type: 'power', power: powered ? 'NETWORK' : 'ON' })}
            className={cx(
              'tip-top tip-end p-1 rounded transition-colors shrink-0',
              !connected ? 'text-faint/40' : powered ? 'text-gold' : 'text-dim hover:text-ink'
            )}
          >
            <Power size={13} />
          </button>
        </div>
      </div>
    </div>
  )
}

function PanelButton({
  children,
  tip,
  enabled,
  onClick
}: {
  children: React.ReactNode
  tip: string
  enabled: boolean
  onClick(): void
}): React.JSX.Element {
  return (
    <button
      data-tip={tip}
      aria-label={tip}
      disabled={!enabled}
      onClick={onClick}
      className={cx(
        'tip-top p-1 rounded transition-colors shrink-0',
        enabled ? 'text-dim hover:text-ink' : 'text-faint/40'
      )}
    >
      {children}
    </button>
  )
}
