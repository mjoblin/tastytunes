import { useEffect, useRef, useState } from 'react'
import { Loader2, Power, Search } from 'lucide-react'
import { tt } from '@/api'
import { useStore } from '@/store'
import { useShortcuts } from '@/hooks/useShortcuts'
import { useArtAccent } from '@/hooks/useArtAccent'
import { useArtLoadable } from '@/hooks/useArtLoadable'
import { useMotionPreference } from '@/hooks/useMotionPreference'
import { useTheme } from '@/hooks/useTheme'
import { useDisplayFont } from '@/hooks/useDisplayFont'
import { deriveNowPlaying } from '@/lib/format'
import { Nav } from '@/components/Nav'
import { PlaybackBar } from '@/components/PlaybackBar'
import { DiagnosticsDrawer } from '@/components/DiagnosticsDrawer'
import { ShortcutsOverlay } from '@/components/ShortcutsOverlay'
import { CommandPalette } from '@/components/CommandPalette'
import { InfoModal } from '@/components/InfoModal'
import { DisplayMode } from '@/components/DisplayMode'
import { NowPlayingScreen } from '@/screens/NowPlayingScreen'
import { QueueScreen } from '@/screens/QueueScreen'
import { PresetsScreen } from '@/screens/PresetsScreen'
import { LibraryScreen } from '@/screens/LibraryScreen'
import { RecentlyPlayedScreen } from '@/screens/RecentlyPlayedScreen'
import { SourcesScreen } from '@/screens/SourcesScreen'
import { DeviceScreen } from '@/screens/DeviceScreen'
import { SettingsScreen } from '@/screens/SettingsScreen'

export default function App(): React.JSX.Element {
  useShortcuts()

  const screen = useStore((s) => s.screen)
  const connection = useStore((s) => s.connection)
  const systemPower = useStore((s) => s.systemPower)
  const playState = useStore((s) => s.playState)
  const nowPlaying = useStore((s) => s.nowPlaying)
  const diagnosticsOpen = useStore((s) => s.diagnosticsOpen)
  const shortcutsOpen = useStore((s) => s.shortcutsOpen)
  const infoOpen = useStore((s) => s.infoOpen)
  const paletteOpen = useStore((s) => s.paletteOpen)
  const displayMode = useStore((s) => s.displayMode)
  const setDisplayMode = useStore((s) => s.setDisplayMode)

  const settings = useStore((s) => s.settings)

  const connected = connection.phase === 'connected'
  const inStandby = connected && systemPower != null && systemPower.power !== 'ON'

  // Per-album accent tint (Plexamp-style), from the current art.
  const theme = useTheme(settings.theme)
  useDisplayFont(settings.displayFont)
  const meta = deriveNowPlaying(playState, nowPlaying)
  const artActive = connected && !inStandby ? meta.artUrl : null
  // A dead art URL must not leave the ambient wash/vignette up with no art.
  const artLoadable = useArtLoadable(artActive)
  useArtAccent(settings.accentFollowsArt ? artActive : null, theme)
  useMotionPreference(settings.motion)

  useEffect(() => {
    if (!connected && displayMode) setDisplayMode(false)
  }, [connected, displayMode, setDisplayMode])

  const ambientVisible =
    artActive != null &&
    artLoadable &&
    (settings.ambientArt === 'all' ||
      (settings.ambientArt === 'now-playing' && screen === 'now-playing'))

  // Full-window ambient: the nav/bar drop their panel tint so the wash is even.
  const setAmbientWindowActive = useStore((s) => s.setAmbientWindowActive)
  const ambientWindow = ambientVisible && settings.ambientCoverage === 'window'
  useEffect(() => {
    setAmbientWindowActive(ambientWindow)
  }, [ambientWindow, setAmbientWindowActive])

  const content = (() => {
    if (screen === 'device') return <DeviceScreen />
    if (screen === 'settings') return <SettingsScreen />
    // Recently played is local history — viewable even while disconnected/standby.
    if (screen === 'recently-played') return <RecentlyPlayedScreen />
    if (!connected) return <ConnectGate />
    if (inStandby) return <StandbyGate />
    switch (screen) {
      case 'now-playing':
        return <NowPlayingScreen />
      case 'queue':
        return <QueueScreen />
      case 'presets':
        return <PresetsScreen />
      case 'library':
        return <LibraryScreen />
      case 'sources':
        return <SourcesScreen />
    }
  })()

  const ambient = ambientVisible && (
    <div aria-hidden className="absolute inset-0 overflow-hidden">
      <div className="ambient-art" style={{ backgroundImage: `url(${artActive})` }} />
      {settings.vignette && <div className="ambient-vignette" />}
    </div>
  )
  const coverWindow = settings.ambientCoverage === 'window'

  return (
    <div className="relative h-full">
      {/* full-window ambient art, behind the translucent chrome */}
      {coverWindow && ambient}

      <div className="relative h-full flex flex-col">
        <div className="flex-1 flex min-h-0 relative">
          <Nav />
          <main className="flex-1 min-w-0 min-h-0 relative">
            {/* main-area-only ambient art, behind the screen content */}
            {!coverWindow && ambient}
            <div className="relative h-full">{content}</div>
            {diagnosticsOpen && <DiagnosticsDrawer />}
          </main>
        </div>
        <PlaybackBar />
        {displayMode && <DisplayMode />}
        {shortcutsOpen && <ShortcutsOverlay />}
        {paletteOpen && <CommandPalette />}
        {infoOpen && <InfoModal />}
      </div>
    </div>
  )
}

/** Shown on streamer screens while there's no live connection. */
function ConnectGate(): React.JSX.Element {
  const connection = useStore((s) => s.connection)
  const devices = useStore((s) => s.devices)
  const discovering = useStore((s) => s.discovering)
  const setScreen = useStore((s) => s.setScreen)
  // Never connected to anything = a true first run: the gate doubles as the
  // welcome screen (connect() stamps lastHost on the first attempt).
  const firstRun = useStore((s) => s.settings.lastHost == null)

  const busy =
    connection.phase === 'connecting' ||
    (connection.phase === 'disconnected' && connection.reconnecting)

  // While the gate sits empty-handed, sweep again every 10s — a streamer
  // that's slow to answer (or powers on later) gets found hands-free. Count
  // completed sweeps so the manual-IP hint can surface after a few misses.
  const [sweeps, setSweeps] = useState(0)
  const prevDiscovering = useRef(discovering)
  useEffect(() => {
    if (prevDiscovering.current && !discovering) setSweeps((n) => n + 1)
    prevDiscovering.current = discovering
  }, [discovering])
  useEffect(() => {
    if (busy || devices.length > 0) return
    const t = setInterval(() => void tt.discover(), 10_000)
    return () => clearInterval(t)
  }, [busy, devices.length])
  const stillLooking = !busy && devices.length === 0 && sweeps >= 3

  return (
    <div className="h-full flex flex-col items-center justify-center gap-5 text-center px-8">
      {busy ? (
        <>
          <Loader2 size={40} className="spin text-amber" />
          <div className="font-display text-xl text-dim">
            {connection.phase === 'connecting'
              ? `Connecting to ${connection.host}…`
              : `Reconnecting to ${(connection as { host: string }).host}…`}
          </div>
        </>
      ) : (
        <>
          {firstRun ? (
            <>
              <div className="font-display font-bold text-[34px] leading-none tracking-tight">
                tasty<span className="text-gold">tunes</span>
              </div>
              <div className="text-[14px] text-dim max-w-md leading-relaxed">
                The hi-fi remote for Cambridge Audio StreamMagic streamers. Streamers on
                your network appear here on their own.
              </div>
            </>
          ) : (
            <>
              <Search size={48} strokeWidth={1.2} className="text-faint/60" />
              <div className="font-display text-2xl text-dim">No streamer connected</div>
            </>
          )}
          {devices.length > 0 ? (
            <div className="space-y-2">
              {devices.map((d) => (
                <button
                  key={d.udn || d.host}
                  onClick={() => void tt.connect(d.host)}
                  className="block w-72 rounded-xl ring-1 ring-edge bg-panel hover:bg-raised px-4 py-3 transition-colors"
                >
                  <div className="text-[13.5px]">{d.friendlyName}</div>
                  <div className="font-mono text-[10.5px] text-faint">
                    {d.model} · {d.host}
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="text-[13px] text-faint max-w-sm">
              {discovering ? 'Searching the network…' : 'No StreamMagic devices found yet.'}
            </div>
          )}
          {stillLooking && (
            <div className="text-[12.5px] text-faint max-w-sm leading-relaxed">
              Still looking — the search repeats on its own. If the streamer sits on a
              different subnet or Wi-Fi band, enter its IP manually below.
            </div>
          )}
          <div className="flex items-center gap-4">
            <button
              onClick={() => void tt.discover()}
              disabled={discovering}
              className="text-[13px] px-4 py-2 rounded-lg bg-amber text-bg font-medium hover:brightness-110 transition-all disabled:opacity-50"
            >
              {discovering ? 'Searching…' : 'Find devices'}
            </button>
            <button
              onClick={() => setScreen('device')}
              className="text-[13px] px-4 py-2 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-95 transition-all"
            >
              Enter IP manually →
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** Shown when the streamer is in network standby. */
function StandbyGate(): React.JSX.Element {
  const systemInfo = useStore((s) => s.systemInfo)

  return (
    <div className="h-full flex flex-col items-center justify-center gap-6 text-center px-8">
      <button
        onClick={() => void tt.command({ type: 'power', power: 'ON' })}
        className="h-24 w-24 rounded-full ring-2 ring-amber/50 text-amber flex items-center justify-center
                   hover:bg-amberdim hover:shadow-[0_0_40px_rgb(var(--amber-rgb)_/_0.35)] transition-all"
        title="Power on"
      >
        <Power size={36} strokeWidth={1.8} />
      </button>
      <div>
        <div className="font-display text-2xl text-dim">
          {systemInfo?.name ?? 'Streamer'} is in standby
        </div>
        <div className="text-[13px] text-faint mt-1.5">Press the lamp to wake it.</div>
      </div>
    </div>
  )
}
