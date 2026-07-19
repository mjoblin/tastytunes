import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bluetooth,
  Cable,
  CornerDownLeft,
  Disc3,
  EyeOff,
  HardDrive,
  Info,
  Keyboard,
  Maximize2,
  MicVocal,
  Moon,
  PictureInPicture2,
  Play,
  Power,
  Radio,
  Repeat,
  Search,
  Shuffle,
  SkipBack,
  SkipForward,
  Square,
  Sun,
  Terminal,
  Usb,
  UserRound,
  Volume2,
  VolumeX
} from 'lucide-react'
import { sleepTrackKey, type SleepAction } from '@shared/ipc'
import { tt } from '@/api'
import { useStore } from '@/store'
import { systemTheme } from '@/hooks/useTheme'
import { activeSourceId, controlSet, cx, deriveNowPlaying } from '@/lib/format'
import { SCREENS, sanitizeNavHidden, sanitizeNavHiddenTools } from '@/lib/screens'
import { scrollToVisible } from '@/lib/scroll'

type Icon = typeof Play

interface Command {
  id: string
  label: string
  /** Section header and fallback right-hand tag. */
  group: string
  /** Overrides the group as the right-hand tag (e.g. "Preset 3", "EVO150"). */
  hint?: string
  icon: Icon
  keywords?: string
  /** Screen commands only: this screen is hidden from the sidebar (still navigable here). */
  hidden?: boolean
  run(): void
}

// Empty-query section order — most-reached first.
const GROUP_ORDER = [
  'Playback',
  'Screens',
  'Sources',
  'Presets',
  'Sleep timer',
  'Power',
  'Devices',
  'View'
]

const SLEEP_DURATIONS: Array<{ minutes: number; label: string }> = [
  { minutes: 15, label: '15 min' },
  { minutes: 30, label: '30 min' },
  { minutes: 45, label: '45 min' },
  { minutes: 60, label: '1 hr' },
  { minutes: 90, label: '1.5 hr' },
  { minutes: 120, label: '2 hr' }
]


function sourceIcon(klass: string): Icon {
  if (/bluetooth/i.test(klass)) return Bluetooth
  if (/radio/i.test(klass)) return Radio
  if (/usb/i.test(klass)) return Usb
  return Cable
}

/**
 * Contiguous-substring or in-order subsequence match. Returns a score (higher =
 * better) or null for no match. Substrings beat subsequences; earlier and
 * more-clustered matches rank higher.
 */
function fuzzyScore(q: string, text: string): number | null {
  if (!q) return 0
  const idx = text.indexOf(q)
  if (idx >= 0) return 1000 - idx
  let ti = 0
  let score = 0
  let streak = 0
  for (const ch of q) {
    const found = text.indexOf(ch, ti)
    if (found < 0) return null
    streak = found === ti ? streak + 1 : 0
    score += 1 + streak
    ti = found + 1
  }
  return score
}

export function CommandPalette(): React.JSX.Element {
  const setPaletteOpen = useStore((s) => s.setPaletteOpen)
  const saveSettings = useStore((s) => s.saveSettings)
  const setScreen = useStore((s) => s.setScreen)
  const setDiagnosticsOpen = useStore((s) => s.setDiagnosticsOpen)
  const setShortcutsOpen = useStore((s) => s.setShortcutsOpen)
  const setInfoOpen = useStore((s) => s.setInfoOpen)
  const setDisplayMode = useStore((s) => s.setDisplayMode)
  const setLyricsOpen = useStore((s) => s.setLyricsOpen)
  const setArtistOpen = useStore((s) => s.setArtistOpen)
  const setContextTab = useStore((s) => s.setContextTab)
  const setSettings = useStore((s) => s.setSettings)

  const connection = useStore((s) => s.connection)
  const systemPower = useStore((s) => s.systemPower)
  const sources = useStore((s) => s.sources)
  const presets = useStore((s) => s.presets)
  const devices = useStore((s) => s.devices)
  const zoneState = useStore((s) => s.zoneState)
  const playState = useStore((s) => s.playState)
  const nowPlaying = useStore((s) => s.nowPlaying)
  const sleep = useStore((s) => s.sleep)
  const displayMode = useStore((s) => s.displayMode)
  const settings = useStore((s) => s.settings)

  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  const connected = connection.phase === 'connected'
  const inStandby = connected && systemPower != null && systemPower.power !== 'ON'
  const currentHost =
    'host' in connection ? (connection as { host: string }).host : null

  const commands = useMemo<Command[]>(() => {
    const cmds: Command[] = []
    const controls = controlSet(nowPlaying)
    const allow = (verb: string): boolean => controls.size === 0 || controls.has(verb)

    // -------- Playback (needs a live, awake streamer)
    if (connected && !inStandby) {
      const playing = playState?.state === 'play'
      cmds.push({
        id: 'toggle',
        label: playing ? 'Pause' : 'Play',
        group: 'Playback',
        icon: Play,
        keywords: 'play pause toggle',
        run: () => void tt.command({ type: 'togglePlayback' })
      })
      if (allow('track_next'))
        cmds.push({
          id: 'next',
          label: 'Next track',
          group: 'Playback',
          icon: SkipForward,
          keywords: 'skip forward',
          run: () => void tt.command({ type: 'nextTrack' })
        })
      if (allow('track_previous'))
        cmds.push({
          id: 'prev',
          label: 'Previous track',
          group: 'Playback',
          icon: SkipBack,
          keywords: 'skip back',
          run: () => void tt.command({ type: 'previousTrack' })
        })
      if (allow('stop'))
        cmds.push({
          id: 'stop',
          label: 'Stop',
          group: 'Playback',
          icon: Square,
          run: () => void tt.command({ type: 'stop' })
        })
      const muted = zoneState?.mute ?? false
      cmds.push({
        id: 'mute',
        label: muted ? 'Unmute' : 'Mute',
        group: 'Playback',
        icon: muted ? VolumeX : Volume2,
        run: () => void tt.command({ type: 'setMute', mute: !muted })
      })
      if (allow('toggle_shuffle')) {
        const on = playState?.mode_shuffle === 'all'
        cmds.push({
          id: 'shuffle',
          label: on ? 'Shuffle off' : 'Shuffle on',
          group: 'Playback',
          icon: Shuffle,
          run: () => void tt.command({ type: 'setShuffle', mode: on ? 'off' : 'all' })
        })
      }
      if (allow('toggle_repeat')) {
        const on = playState?.mode_repeat === 'all'
        cmds.push({
          id: 'repeat',
          label: on ? 'Repeat off' : 'Repeat all',
          group: 'Playback',
          icon: Repeat,
          run: () => void tt.command({ type: 'setRepeat', mode: on ? 'off' : 'all' })
        })
      }
    }

    // -------- Screens (always available — hidden-from-sidebar screens included,
    // flagged so the row shows they won't appear in the nav)
    const navHidden = new Set(sanitizeNavHidden(settings.navHidden))
    for (const sc of SCREENS) {
      cmds.push({
        id: `screen:${sc.id}`,
        label: sc.label,
        group: 'Screens',
        hint: `Screen · ${sc.key}`,
        icon: sc.icon,
        keywords: navHidden.has(sc.id) ? 'go to open view screen hidden sidebar' : 'go to open view screen',
        hidden: navHidden.has(sc.id),
        run: () => setScreen(sc.id)
      })
    }

    // -------- Sources
    if (connected && !inStandby) {
      const activeId = activeSourceId(zoneState, nowPlaying)
      const selectable = (sources?.sources ?? [])
        .filter((s) => s.ui_selectable)
        .sort((a, b) => a.preferred_order - b.preferred_order)
      for (const src of selectable) {
        if (src.id === activeId) continue
        cmds.push({
          id: `source:${src.id}`,
          label: `Switch to ${src.name}`,
          group: 'Sources',
          hint: 'Source',
          icon: sourceIcon(src.class),
          keywords: `${src.id} input`,
          run: () => void tt.command({ type: 'setSource', sourceId: src.id })
        })
      }
    }

    // -------- Presets (by name)
    if (connected && !inStandby) {
      for (const p of presets?.presets ?? []) {
        if (p.id == null || !p.name) continue
        cmds.push({
          id: `preset:${p.id}`,
          label: p.name,
          group: 'Presets',
          hint: `Preset ${p.id}`,
          icon: Radio,
          keywords: 'recall station',
          run: () => void tt.command({ type: 'recallPreset', presetId: p.id as number })
        })
      }
    }

    // -------- Sleep timer
    if (connected && !inStandby) {
      const action: SleepAction =
        settings.sleepAction === 'pause' || settings.sleepAction === 'standby'
          ? settings.sleepAction
          : 'standby'
      const verb = action === 'standby' ? 'Standby' : 'Pause'
      for (const d of SLEEP_DURATIONS) {
        cmds.push({
          id: `sleep:${d.minutes}`,
          label: `Sleep in ${d.label}`,
          group: 'Sleep timer',
          hint: verb,
          icon: Moon,
          keywords: 'timer countdown',
          run: () =>
            void tt.setSleep({
              action,
              minutes: d.minutes,
              firesAt: Date.now() + d.minutes * 60_000,
              trackKey: null
            })
        })
      }
      const meta = deriveNowPlaying(playState, nowPlaying)
      const duration =
        playState?.metadata?.duration ?? nowPlaying?.display?.progress?.duration ?? null
      if (sleepTrackKey(playState) != null && duration != null && duration > 0 && !meta.isRadio) {
        cmds.push({
          id: 'sleep:eot',
          label: 'Sleep at end of track',
          group: 'Sleep timer',
          hint: verb,
          icon: Moon,
          keywords: 'timer end of track',
          run: () =>
            void tt.setSleep({
              action,
              minutes: null,
              firesAt: null,
              trackKey: sleepTrackKey(playState)
            })
        })
      }
      if (sleep) {
        cmds.push({
          id: 'sleep:cancel',
          label: 'Cancel sleep timer',
          group: 'Sleep timer',
          icon: Moon,
          keywords: 'disable off',
          run: () => void tt.setSleep(null)
        })
      }
    }

    // -------- Power
    if (connected) {
      if (systemPower?.power === 'ON') {
        cmds.push({
          id: 'power:standby',
          label: 'Standby',
          group: 'Power',
          icon: Power,
          keywords: 'sleep network off',
          run: () => void tt.command({ type: 'power', power: 'NETWORK' })
        })
      } else {
        cmds.push({
          id: 'power:on',
          label: 'Power on',
          group: 'Power',
          icon: Power,
          keywords: 'wake turn on',
          run: () => void tt.command({ type: 'power', power: 'ON' })
        })
      }
    }

    // -------- Devices (switch / connect)
    for (const d of devices) {
      if (d.host === currentHost) continue
      cmds.push({
        id: `device:${d.host}`,
        label: `${connected ? 'Switch to' : 'Connect to'} ${d.friendlyName}`,
        group: 'Devices',
        hint: d.model,
        icon: HardDrive,
        keywords: `${d.host} streamer`,
        run: () => void tt.connect(d.host)
      })
    }

    // -------- View / app
    // Mirror the hidden-from-sidebar hint the hidden screens get: when the
    // Mini player nav button is hidden, flag its palette row too (still runs).
    const miniHiddenFromNav = sanitizeNavHiddenTools(settings.navHiddenTools).includes('mini-player')
    cmds.push({
      id: 'view:mini',
      label: 'Toggle mini player',
      group: 'View',
      icon: PictureInPicture2,
      keywords: miniHiddenFromNav ? 'miniplayer window hidden sidebar' : 'miniplayer window',
      hidden: miniHiddenFromNav,
      run: () => void tt.toggleMini()
    })
    if (connected && !inStandby) {
      cmds.push({
        id: 'view:display',
        label: displayMode ? 'Exit display mode' : 'Full-screen display mode',
        group: 'View',
        hint: 'F',
        icon: Maximize2,
        keywords: 'fullscreen wall',
        run: () => setDisplayMode(!displayMode)
      })
    }
    // The drawers live on Now Playing — running these navigates there first.
    // Same metadata gating as the screen's header buttons (no radio, needs artist).
    if (connected && !inStandby) {
      const npMeta = deriveNowPlaying(playState, nowPlaying)
      if (settings.lyrics && !npMeta.isRadio && npMeta.title && npMeta.subtitle) {
        cmds.push({
          id: 'view:lyrics',
          label: 'Lyrics',
          group: 'View',
          icon: MicVocal,
          keywords: 'lyrics panel words song',
          run: () => {
            setScreen('now-playing')
            setLyricsOpen(true)
          }
        })
      }
      if (settings.artistInfo && !npMeta.isRadio && npMeta.subtitle) {
        cmds.push({
          id: 'view:artist',
          label: 'About the artist',
          group: 'View',
          icon: UserRound,
          keywords: 'artist bio wikipedia musicbrainz context',
          run: () => {
            setScreen('now-playing')
            setContextTab('artist')
            setArtistOpen(true)
          }
        })
      }
      if (settings.artistInfo && !npMeta.isRadio && npMeta.subtitle && npMeta.album) {
        cmds.push({
          id: 'view:album',
          label: 'About the album',
          group: 'View',
          icon: Disc3,
          keywords: 'album release year label credits context',
          run: () => {
            setScreen('now-playing')
            setContextTab('album')
            setArtistOpen(true)
          }
        })
      }
    }
    // Toggle from the RESOLVED theme (the stored preference may be 'system');
    // running it always writes an explicit theme, which is what a toggle means.
    const shownTheme = settings.theme === 'system' ? systemTheme() : settings.theme
    cmds.push({
      id: 'view:theme',
      label: shownTheme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
      group: 'View',
      icon: shownTheme === 'dark' ? Sun : Moon,
      keywords: 'appearance dark light',
      run: () => {
        void (async () => {
          await saveSettings({ theme: shownTheme === 'dark' ? 'light' : 'dark' })
        })()
      }
    })
    cmds.push({
      id: 'view:diagnostics',
      label: 'Open SMOIP payload console',
      group: 'View',
      hint: '`',
      icon: Terminal,
      keywords: 'diagnostics debug frames',
      run: () => setDiagnosticsOpen(true)
    })
    cmds.push({
      id: 'view:shortcuts',
      label: 'Keyboard shortcuts',
      group: 'View',
      hint: '?',
      icon: Keyboard,
      run: () => setShortcutsOpen(true)
    })
    cmds.push({
      id: 'view:about',
      label: 'About TastyTunes',
      group: 'View',
      icon: Info,
      keywords: 'support version info',
      run: () => setInfoOpen(true)
    })

    return cmds
  }, [
    connected,
    inStandby,
    currentHost,
    playState,
    nowPlaying,
    zoneState,
    sources,
    presets,
    devices,
    sleep,
    systemPower,
    displayMode,
    settings.theme,
    settings.sleepAction,
    settings.lyrics,
    settings.artistInfo,
    settings.navHidden,
    settings.navHiddenTools,
    setLyricsOpen,
    setArtistOpen,
    setContextTab,
    setScreen,
    setDiagnosticsOpen,
    setShortcutsOpen,
    setInfoOpen,
    setDisplayMode,
    setSettings,
    setPaletteOpen
  ])

  const q = query.trim().toLowerCase()
  const filtered = useMemo<Command[]>(() => {
    if (!q) {
      return [...commands].sort(
        (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group)
      )
    }
    return commands
      .map((c) => {
        const hay = `${c.label} ${c.hint ?? ''} ${c.group} ${c.keywords ?? ''}`.toLowerCase()
        const labelScore = fuzzyScore(q, c.label.toLowerCase())
        const hayScore = fuzzyScore(q, hay)
        if (labelScore == null && hayScore == null) return null
        return { c, score: Math.max((labelScore ?? -1) * 2, hayScore ?? -1) }
      })
      .filter((x): x is { c: Command; score: number } => x != null)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c)
  }, [commands, q])

  // Keep the selection valid as the result set changes.
  useEffect(() => {
    setSelected(0)
  }, [q])
  useEffect(() => {
    if (selected > filtered.length - 1) setSelected(Math.max(0, filtered.length - 1))
  }, [filtered.length, selected])

  // Scroll the active row into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-selected="true"]')
    scrollToVisible(el ?? null)
  }, [selected, filtered])

  const run = (cmd: Command | undefined): void => {
    if (!cmd) return
    setPaletteOpen(false)
    cmd.run()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelected((i) => Math.min(filtered.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelected((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(filtered[selected])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setPaletteOpen(false)
    }
  }

  const showHeaders = q === ''
  let lastGroup = ''

  return (
    <div
      className="absolute inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-[12vh]"
      onClick={() => setPaletteOpen(false)}
    >
      <div
        className="w-[560px] max-w-[90vw] rounded-2xl bg-panel ring-1 ring-edge2 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 border-b border-edge">
          <Search size={17} className="text-faint shrink-0" />
          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a command — transport, sources, presets, screens…"
            className="flex-1 bg-transparent outline-none py-3.5 text-[14px] placeholder:text-faint"
          />
          <span className="microlabel shrink-0">⌘K</span>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-2">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-faint">No matching commands</div>
          ) : (
            filtered.map((cmd, i) => {
              const header = showHeaders && cmd.group !== lastGroup ? cmd.group : null
              if (header) lastGroup = cmd.group
              const Icon = cmd.icon
              const active = i === selected
              return (
                <div key={cmd.id}>
                  {header && <div className="microlabel px-4 pt-3 pb-1.5">{header}</div>}
                  <button
                    data-selected={active || undefined}
                    onMouseMove={() => setSelected(i)}
                    onClick={() => run(cmd)}
                    className={cx(
                      'w-full flex items-center gap-3 px-4 py-2 text-left transition-colors',
                      active ? 'bg-amberdim text-amber' : 'text-ink hover:bg-veil'
                    )}
                  >
                    <Icon
                      size={16}
                      strokeWidth={1.8}
                      className={cx('shrink-0', active ? 'text-amber' : 'text-dim')}
                    />
                    <span className="flex-1 min-w-0 truncate text-[13.5px]">{cmd.label}</span>
                    {cmd.hidden && (
                      <EyeOff
                        size={12}
                        strokeWidth={1.8}
                        aria-label="Hidden from sidebar"
                        className="shrink-0 text-faint/70"
                      />
                    )}
                    <span className="shrink-0 font-mono text-[10px] text-faint/80">
                      {cmd.hint ?? cmd.group}
                    </span>
                  </button>
                </div>
              )
            })
          )}
        </div>

        <div className="flex items-center gap-4 px-4 py-2 border-t border-edge text-faint">
          <span className="flex items-center gap-1.5 text-[11px]">
            <CornerDownLeft size={12} /> run
          </span>
          <span className="flex items-center gap-1.5 text-[11px] font-mono">↑↓ move</span>
          <span className="flex items-center gap-1.5 text-[11px] font-mono">esc close</span>
          <span className="flex-1" />
          <span className="text-[11px] tabular-nums">{filtered.length}</span>
        </div>
      </div>
    </div>
  )
}
