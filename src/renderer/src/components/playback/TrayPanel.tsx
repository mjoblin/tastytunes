import { useEffect, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Disc3,
  Heart,
  LayoutGrid,
  Loader2,
  Maximize2,
  Pause,
  Play,
  Power,
  RadioTower,
  Repeat,
  Rows3,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX
} from 'lucide-react'
import { isCbusMode, isPreAmpMode } from '@shared/smoip'
import type { ScreenLayout } from '@shared/model'
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
import { SignalLamp } from '@/components/device/SignalLamp'
import { Segmented } from '@/components/controls/Segmented'
import {
  PlaylistsTab,
  PresetsTab,
  QueueTab,
  RecentTab,
  type TrayDensity,
  type TrayTab
} from '@/components/playback/TrayPanelTabs'
import { controlSet, cx, deriveNowPlaying, fmtTime } from '@/lib/format'

const TABS: readonly TrayTab[] = ['queue', 'presets', 'playlists', 'recent']
/** A stored tab from a future (or hand-edited) settings file must not blank the body. */
const coerceTab = (v: string): TrayTab =>
  (TABS as readonly string[]).includes(v) ? (v as TrayTab) : 'queue'

/**
 * The tray panel (?tray=1): what's playing, reachable without a window.
 *
 * NOT A SECOND MINI PLAYER, and the difference is the reason both are allowed
 * to exist. The mini is PERSISTENT and PLACED — you position it once and leave
 * it sitting over your work. The panel is TRANSIENT and ANCHORED — it appears
 * under the tray icon, you do one thing, it dismisses on blur. Its
 * justification is reach without a window, not "small now playing".
 *
 * LAYOUT IS SPACE-FIRST. Every row here earns its height: identity, then
 * transport with the playhead beside it, then a single status line carrying
 * source, format, signal and power. There is no footer — the way back to the
 * app is an icon in the tab row, because a whole 36px strip to say one word is
 * exactly the kind of thing a 380px window can't afford.
 *
 * Everything arrives through the same pushes the main window gets
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
  const saveSettings = useStore((s) => s.saveSettings)
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

  // ---- tabs and view controls.
  //
  // The tab is remembered across opens (same precedent as settingsTab), then
  // overridden by ONE heuristic rather than a knob. Density and the presets
  // layout are the panel's OWN settings, not the main window's: a preference
  // travels between surfaces, a question about what fits does not. See
  // AppSettings.trayRowDensity for the rule.
  const density: TrayDensity = settings.trayRowDensity
  const presetsLayout: ScreenLayout = settings.trayPresetsLayout
  const [tab, setTab] = useState<TrayTab>(() => coerceTab(settings.trayTab))
  const opens = useStore((s) => s.trayOpens)
  const pickTab = (next: TrayTab): void => {
    setTab(next)
    void saveSettings({ trayTab: next })
  }
  // Keyed on the OPEN COUNT, not on visibility: the panel is hidden rather
  // than destroyed, so this component never remounts and a boolean couldn't
  // tell two consecutive opens apart. Reads live values without subscribing,
  // so a queue emptying while the panel sits open doesn't yank the tab out
  // from under a click.
  useEffect(() => {
    if (opens === 0) return
    const s = useStore.getState()
    // "A queue tab on an idle streamer is an empty box" — two ways to get one,
    // and both count. Nothing playing (stopped, or never started) is the
    // obvious case; the other is RADIO, which plays happily with no queue
    // behind it at all. Paused counts as playing: you paused it, the queue is
    // still yours, and Queue is where you meant to be.
    const st = s.playState?.state
    const nothingPlaying = st !== 'play' && st !== 'pause'
    const emptyQueue = (s.queue?.items?.length ?? 0) === 0
    const stored = coerceTab(s.settings.trayTab)
    setTab(stored === 'queue' && (nothingPlaying || emptyQueue) ? 'presets' : stored)
  }, [opens])

  // ---- playlist activation, and the dismissal rules it drives.
  //
  // Started HERE, specifically: a run someone kicked off in the main window
  // must not hold this panel open — the rule is about not losing YOUR click's
  // progress, not about any activation anywhere.
  const activation = useStore((s) => s.playlistActivation)
  const [startedId, setStartedId] = useState<string | null>(null)
  const holding =
    startedId != null && !!activation && !activation.finished && activation.playlistId === startedId
  const startActivation = (p: { id: string; name: string }): void => {
    setStartedId(p.id)
    setTab('playlists')
    void tt.playlistActivate(p.id).catch(() => setStartedId(null))
  }
  useEffect(() => {
    if (activation?.finished && activation.playlistId === startedId) setStartedId(null)
  }, [activation?.finished, activation?.playlistId, startedId])
  // NB main holds the panel open independently, and learns the run is the
  // panel's from the IPC SENDER of playlistActivate rather than from a message
  // — nothing here needs to tell it. This local flag is only for the cue.

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
  const canSeek = controls.has('seek') && duration != null && duration > 0
  const canShuffle = controls.has('toggle_shuffle')
  const canRepeat = controls.has('toggle_repeat')
  const repeatOn = playState?.mode_repeat === 'all'
  const shuffleOn = playState?.mode_shuffle === 'all'

  const muted = zoneState?.mute === true
  const preAmp = isPreAmpMode(zoneState)
  const cbus = isCbusMode(zoneState)
  const hasVolume = zoneState != null && (preAmp || cbus)

  // ---- seek. Local scrub so the thumb tracks the drag rather than the
  // streamer's next push, which arrives about a second later.
  const [scrub, setScrub] = useState<number | null>(null)
  const shownPosition = scrub != null && duration ? scrub * duration : position

  // The status line. A panel that hides the streamer's state lies about it, so
  // connection and standby are always readable — and wake-from-standby is
  // genuinely menu-bar-shaped (it's midnight, the app isn't open, the streamer
  // is asleep).
  const deviceName = systemInfo?.name?.trim() || (connected ? connection.host : null)
  const sourceName = active ? (nowPlaying?.source?.name ?? null) : null
  // SOURCE AND DEVICE, both — they answer different questions ("what's feeding
  // it" vs "which streamer am I driving", and the second one matters the
  // moment there are two). Truncated with the full string on the title, which
  // is what the space allows.
  const statusText = !connected
    ? connection.phase === 'connecting'
      ? 'Connecting…'
      : 'Not connected'
    : !powered
      ? `${deviceName ?? 'Streamer'} · Standby`
      : [sourceName, deviceName].filter(Boolean).join(' · ') || 'Connected'
  // Format detail is the badges the app already derives (codec / rate / depth).
  // Compressed to a single string: the panel has one line for this, and the
  // full chain is a click away on the lamp.
  const formatText = active ? meta.badges.slice(0, 3).join(' · ') : ''

  return (
    <div className="h-screen w-screen p-1">
      <div
        data-tray-holding={holding || undefined}
        className={cx(
          'relative h-full w-full rounded-2xl bg-panel overflow-hidden flex flex-col shadow-[0_18px_50px_rgb(0_0_0_/_0.55)] ring-1 transition-[box-shadow,--tw-ring-color]',
          // THE CUE. While a run this panel started is in flight, blur no
          // longer dismisses — and a surface that refuses to close without
          // saying why reads as stuck, not protective. A gold edge is the
          // quietest thing that says "held on purpose"; the tab's own row
          // carries the count and the cancel.
          holding ? 'ring-gold/60' : 'ring-edge2'
        )}
      >
        <AmbientArt
          src={active && settings.ambientArt !== 'off' ? (art ?? null) : null}
          vignette={settings.vignette}
        />

        {/* ---- identity + volume ----
            Wheel-to-volume is scoped to the HEADER, not the whole surface as
            in the mini player. The mini has nothing that scrolls, so
            wheel-anywhere is unambiguous there; here the tab body is a list,
            and a wheel bubbling out of it changed the volume while you were
            only trying to read the queue. */}
        <div className="relative shrink-0 px-3 pt-3 pb-1.5" onWheel={onWheel}>
          <div className="flex items-start gap-2.5">
            <div className="relative h-14 w-14 shrink-0 rounded-lg overflow-hidden bg-raised flex items-center justify-center">
              <ArtImage
                src={active ? art : null}
                fallback={
                  meta.isRadio && active ? (
                    <RadioTower size={22} className="text-faint" />
                  ) : (
                    <Disc3 size={22} className="text-faint" />
                  )
                }
              />
            </div>
            <div className="flex-1 min-w-0 pt-0.5">
              {/* min-heights keep the lines occupying space through the brief
                  metadata gap on a track change, so nothing shifts. */}
              <div className="font-display no-optical font-bold tracking-tight text-[14px] text-ink truncate leading-tight min-h-[17px]">
                {active ? (meta.title ?? ' ') : 'Nothing playing'}
              </div>
              <div className="font-display no-optical tracking-tight text-[12px] text-dim truncate leading-tight min-h-[14px]">
                {(active && meta.subtitle) || ' '}
              </div>
              <div className="text-[11px] text-faint truncate leading-tight min-h-[13px]">
                {(active && meta.album) || ' '}
              </div>
            </div>
            {/* VOLUME, compact — the PunyTunes affordance, adapted. A
                full-width slider ate the transport row and left nowhere for a
                playhead; a mute toggle, the level, and two steps do the same
                job in a fifth of the width. The wheel over this header is the
                fast path (shift for 5 at a time), which is what the mute
                button's tooltip has always taught. */}
            {hasVolume && (
              <div className="shrink-0 flex items-center gap-0.5">
                <button
                  data-tip={muted ? 'Unmute — scroll for volume' : 'Mute — scroll for volume'}
                  aria-label={muted ? 'Unmute' : 'Mute'}
                  onClick={() => void tt.command({ type: 'setMute', mute: !muted })}
                  className={cx(
                    'tip-bottom p-1 rounded transition-colors',
                    muted ? 'text-gold' : 'text-dim hover:text-ink'
                  )}
                >
                  {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                </button>
                {/* Control Bus has no absolute level to show — steps only. */}
                {preAmp && (
                  <span
                    className={cx(
                      'font-mono text-[11px] tabular-nums w-6 text-right',
                      muted ? 'text-faint' : 'text-dim'
                    )}
                  >
                    {vol.levelNow ?? '—'}
                  </span>
                )}
                <div className="flex flex-col">
                  <VolStep dir={1} enabled={active} />
                  <VolStep dir={-1} enabled={active} />
                </div>
              </div>
            )}
            {heart.available && active && (
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

          {/* ---- transport + modes + playhead, on one line ---- */}
          <div className="flex items-center gap-1 mt-2">
            <PanelButton enabled={active && canPrev} tip="Previous" onClick={() => void tt.command({ type: 'previousTrack' })}>
              <SkipBack size={14} />
            </PanelButton>
            <button
              data-tip={playing ? 'Pause' : 'Play'}
              aria-label={playing ? 'Pause' : 'Play'}
              disabled={!active || (!canToggle && !busy)}
              onClick={() => void tt.command({ type: 'togglePlayback' })}
              className={cx(
                'tip-top h-8 w-8 rounded-full flex items-center justify-center transition-all shrink-0',
                active && (canToggle || busy) ? 'bg-gold text-bg motion-safe:hover:scale-105' : 'bg-veil2 text-faint'
              )}
            >
              {busy ? (
                <Loader2 size={14} className="spin" />
              ) : playing ? (
                <Pause size={14} fill="currentColor" strokeWidth={0} />
              ) : (
                <Play size={14} fill="currentColor" strokeWidth={0} className="translate-x-[1px]" />
              )}
            </button>
            <PanelButton enabled={active && canNext} tip="Next" onClick={() => void tt.command({ type: 'nextTrack' })}>
              <SkipForward size={14} />
            </PanelButton>
            {/* Shuffle and repeat live HERE rather than in the context menu.
                The earlier call sent them to the menu purely on space, and
                once the volume cluster gave the transport row its width back
                that argument stopped holding — they are one click to an
                outcome, which is the panel's own admission test. */}
            <PanelButton
              enabled={active && canShuffle}
              tip="Shuffle"
              active={shuffleOn}
              onClick={() => void tt.command({ type: 'setShuffle', mode: shuffleOn ? 'off' : 'all' })}
            >
              <Shuffle size={13} />
            </PanelButton>
            <PanelButton
              enabled={active && canRepeat}
              tip="Repeat"
              active={repeatOn}
              onClick={() => void tt.command({ type: 'setRepeat', mode: repeatOn ? 'off' : 'all' })}
            >
              <Repeat size={13} />
            </PanelButton>

            <span className="font-mono text-[10px] text-faint tabular-nums shrink-0 ml-1 w-8 text-right">
              {active ? fmtTime(shownPosition) : ''}
            </span>
            <div className="flex-1 min-w-0">
              {/* The position tooltip comes free: Slider's scrubLabel renders a
                  portaled, clamped bubble on hover as well as drag — the seek
                  bar is usually clicked rather than dragged, so a click needs
                  to know where it will land. */}
              <Slider
                value={duration ? shownPosition / duration : 0}
                disabled={!active || !canSeek}
                ariaLabel="Playhead"
                scrubLabel={duration ? (v) => fmtTime(v * duration) : undefined}
                onScrub={setScrub}
                onCancel={() => setScrub(null)}
                onCommit={(v) => {
                  setScrub(null)
                  if (duration) void tt.command({ type: 'seek', positionSecs: v * duration })
                }}
              />
            </div>
            <span className="font-mono text-[10px] text-faint tabular-nums shrink-0 w-8">
              {active && duration != null ? fmtTime(duration) : ''}
            </span>
          </div>
        </div>

        {/* ---- status: signal, source, format, power ----
            One line doing what a 36px footer used to. Power sits at the RIGHT,
            mirroring the playback bar's right cluster: a widget of a given type
            belongs in the same place on every surface that has one. */}
        <div className="relative shrink-0 flex items-center gap-1.5 px-3 h-6 text-[11px]">
          <div className="shrink-0 -ml-1.5 scale-90 origin-left">
            <SignalLamp />
          </div>
          <span className="text-dim truncate shrink-0 max-w-[45%]" title={statusText}>
            {statusText}
          </span>
          {formatText && <span className="text-faint truncate font-mono text-[10px]">{formatText}</span>}
          <div className="flex-1" />
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

        {/* ---- tabs + view controls ----
            Four is the practical ceiling: at this width a TEXT Segmented fits
            four ("Playlists" alone eats ~55px), and a fifth would force
            icon-only and throw away the app's partition idiom. The view
            controls sit to its right, which is where the app puts layout
            chips on every list screen. */}
        <div className="relative shrink-0 flex items-center gap-1.5 px-2.5 py-1.5">
          <Segmented<TrayTab>
            value={tab}
            onChange={pickTab}
            className="flex-1 min-w-0 [&>button]:flex-1 [&>button]:min-w-0"
            options={[
              { value: 'queue', label: 'Queue' },
              { value: 'presets', label: 'Presets' },
              { value: 'playlists', label: 'Playlists' },
              { value: 'recent', label: 'Recent' }
            ]}
          />
          {tab === 'presets' && (
            <ViewChip
              tip={presetsLayout === 'cards' ? 'View as rows' : 'View as cards'}
              onClick={() =>
                void saveSettings({ trayPresetsLayout: presetsLayout === 'cards' ? 'rows' : 'cards' })
              }
            >
              {presetsLayout === 'cards' ? <Rows3 size={13} /> : <LayoutGrid size={13} />}
            </ViewChip>
          )}
          <ViewChip
            tip={density === 'detailed' ? 'Compact rows' : 'Detailed rows'}
            active={density === 'compressed'}
            attrs={{ 'data-tray-density': density }}
            onClick={() =>
              void saveSettings({ trayRowDensity: density === 'detailed' ? 'compressed' : 'detailed' })
            }
          >
            <Rows3 size={13} />
          </ViewChip>
          <ViewChip tip="Open TastyTunes" onClick={() => void tt.showMain()}>
            <Maximize2 size={13} />
          </ViewChip>
        </div>

        {/* `key` per tab so the scroller REMOUNTS: without it the container is
            one DOM node and its scrollTop carries across, so switching away
            from a queue scrolled to the playing row landed you halfway down
            the presets. It also re-runs the queue's scroll-to-playing effect
            on every return to that tab, which is what you'd want anyway. */}
        <div
          key={tab}
          className="relative flex-1 min-h-0 overflow-y-auto pb-1"
          data-tray-body={tab}
        >
          {tab === 'queue' && <QueueTab opens={opens} density={density} />}
          {tab === 'presets' && <PresetsTab layout={presetsLayout} density={density} />}
          {tab === 'playlists' && <PlaylistsTab density={density} onActivate={startActivation} />}
          {tab === 'recent' && <RecentTab density={density} />}
        </div>
      </div>
    </div>
  )
}

/** One volume step. Two of these stacked replace a slider in a fifth the width. */
function VolStep({ dir, enabled }: { dir: 1 | -1; enabled: boolean }): React.JSX.Element {
  return (
    <button
      data-tip={dir > 0 ? 'Volume up' : 'Volume down'}
      aria-label={dir > 0 ? 'Volume up' : 'Volume down'}
      disabled={!enabled}
      onClick={() => void tt.command({ type: 'volumeStepChange', delta: dir })}
      className={cx(
        'tip-bottom tip-end px-0.5 leading-none transition-colors',
        enabled ? 'text-dim hover:text-ink' : 'text-faint/40'
      )}
    >
      {dir > 0 ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
    </button>
  )
}

function PanelButton({
  children,
  tip,
  enabled,
  active,
  onClick
}: {
  children: React.ReactNode
  tip: string
  enabled: boolean
  active?: boolean
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
        !enabled ? 'text-faint/40' : active ? 'text-gold' : 'text-dim hover:text-ink'
      )}
    >
      {children}
    </button>
  )
}

/** The panel's layout chips — the app's HeaderChip idiom at panel scale. */
function ViewChip({
  children,
  tip,
  active,
  attrs,
  onClick
}: {
  children: React.ReactNode
  tip: string
  active?: boolean
  attrs?: Record<string, string | undefined>
  onClick(): void
}): React.JSX.Element {
  return (
    <button
      {...attrs}
      data-tip={tip}
      aria-label={tip}
      onClick={onClick}
      className={cx(
        'tip-bottom tip-end shrink-0 p-1.5 rounded-lg ring-1 transition-colors',
        active ? 'ring-gold/50 text-gold bg-golddim/40' : 'ring-edge text-dim hover:text-ink hover:ring-edge2'
      )}
    >
      {children}
    </button>
  )
}
