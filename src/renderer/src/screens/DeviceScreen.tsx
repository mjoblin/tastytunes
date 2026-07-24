import { useState } from 'react'
import { ArrowUpCircle, Check, ExternalLink, Loader2, RefreshCw, Sparkles, Unplug } from 'lucide-react'
import { audioCaps } from '@shared/smoip'
import { tt } from '@/api'
import { useStore } from '@/store'
import { useScrollMemory } from '@/hooks/useScrollMemory'
import { cx } from '@/lib/format'
import { Segmented } from '@/components/Segmented'
import { ToneEq } from '@/components/ToneEq'
import { DeviceControls } from '@/components/DeviceControls'

export function DeviceScreen(): React.JSX.Element {
  const connection = useStore((s) => s.connection)
  const devices = useStore((s) => s.devices)
  const discovering = useStore((s) => s.discovering)
  const systemInfo = useStore((s) => s.systemInfo)
  // PASSIVE firmware awareness: shown here, never acted on. There is no check or
  // install control anywhere — updating is the user's job via the official app
  // or the streamer's web admin (the "Open web admin" button below).
  const firmwareUpdate = useStore((s) => s.firmwareUpdate)
  const audioSpec = useStore((s) => s.audioSpec)
  const deviceTab = useStore((s) => s.settings.deviceTab)
  const saveSettings = useStore((s) => s.saveSettings)
  const [manualHost, setManualHost] = useState('')
  // Tabs exist only when this streamer HAS tone controls; without them the
  // streamer info stands alone. A persisted 'tone' pick degrades gracefully.
  const hasToneTab = audioCaps(audioSpec) != null
  const activeTab = hasToneTab && deviceTab === 'tone' ? 'tone' : 'streamer'

  const connectedHost = connection.phase === 'connected' ? connection.host : null
  const busyHost =
    connection.phase === 'connecting' || (connection.phase === 'disconnected' && connection.reconnecting)
      ? connection.host
      : null

  const statusText = (() => {
    switch (connection.phase) {
      case 'idle':
        return 'Not connected'
      case 'connecting':
        return `Connecting to ${connection.host}… (attempt ${connection.attempt})`
      case 'connected':
        return connection.demo ? 'Connected to the built-in demo' : `Connected to ${connection.host}`
      case 'disconnected':
        return connection.reconnecting
          ? `Lost connection to ${connection.host} (${connection.reason}) — reconnecting…`
          : `Disconnected from ${connection.host}`
    }
  })()

  return (
    <div className="h-full flex flex-col">
      <header className="drag-region flex items-center gap-4 px-8 pt-8 pb-4">
        <h1 className="font-display screen-title font-bold text-[26px] tracking-tight">Device</h1>
      </header>

      {/* pinned header; only the content scrolls (house pattern) */}
      <div ref={useScrollMemory('device')} className="flex-1 overflow-y-auto px-8 pb-10 pt-1">
        <div className="max-w-2xl space-y-8">
        {/* ------------------------------------------------------------ connection */}
        <section className="space-y-3">
          <div className="microlabel">connection</div>
          <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-4">
            <div className="flex items-center gap-3">
              <span
                className={cx(
                  'led',
                  connection.phase === 'connected' ? 'led-on' : busyHost ? 'led-busy' : 'led-off'
                )}
              />
              <span className="text-[13.5px] flex-1">{statusText}</span>
              {connection.phase !== 'idle' && (
                <button
                  onClick={() => void tt.disconnect()}
                  className="flex items-center gap-1.5 text-[12.5px] px-3 h-8 rounded-lg ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70 motion-safe:active:scale-95 transition-all"
                >
                  <Unplug size={13} /> Disconnect
                </button>
              )}
            </div>

            <div className="border-t border-edge pt-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[12.5px] text-dim">Discovered streamers</span>
                <button
                  onClick={() => void tt.discover()}
                  disabled={discovering}
                  className="flex items-center gap-1.5 text-[12.5px] px-3 h-8 rounded-lg ring-1 ring-edge bg-panel/70 text-amber hover:brightness-110 hover:ring-edge2 motion-safe:active:scale-95 transition-all disabled:opacity-50"
                >
                  {discovering ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
                  {discovering ? 'Searching…' : 'Find devices'}
                </button>
              </div>

              {devices.length === 0 && !discovering && (
                <div className="text-[12.5px] text-faint">
                  Nothing found yet. Ensure the streamer is on the same network, or enter its IP
                  below.
                </div>
              )}

              {devices.map((device) => (
                <div
                  key={device.udn || device.host}
                  className="flex items-center gap-3 rounded-lg bg-raised/70 ring-1 ring-edge px-3 py-2"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] truncate">{device.friendlyName}</div>
                    <div className="font-mono text-[10.5px] text-faint truncate">
                      {device.model} · {device.host}
                    </div>
                  </div>
                  {device.host === connectedHost ? (
                    <span className="microlabel text-led!">connected</span>
                  ) : (
                    <button
                      onClick={() => void tt.connect(device.host)}
                      className="text-[12px] px-3 py-1.5 rounded-lg ring-1 ring-amber/40 bg-amberdim text-amber hover:brightness-110 hover:ring-amber/60 motion-safe:active:scale-95 transition-all"
                    >
                      Connect
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="border-t border-edge pt-3">
              <div className="flex gap-2">
                <input
                  value={manualHost}
                  onChange={(e) => setManualHost(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && manualHost.trim()) void tt.connect(manualHost.trim())
                  }}
                  placeholder="Hostname or IP (e.g. 192.168.1.42)"
                  className="flex-1 bg-bg rounded-lg ring-1 ring-edge focus:ring-edge2 outline-none px-3 py-1.5 text-[13px] placeholder:text-faint"
                />
                <button
                  disabled={!manualHost.trim()}
                  onClick={() => void tt.connect(manualHost.trim())}
                  className="text-[12.5px] px-3 py-1.5 rounded-lg bg-amber text-bg font-medium disabled:opacity-40 hover:brightness-110 transition-all"
                >
                  Connect
                </button>
              </div>
            </div>

            {/* same escape hatch the connect gate offers, mirrored here */}
            {!connectedHost && !busyHost && (
              <button
                onClick={() => void tt.demoStart()}
                className="mt-9 flex items-center gap-2 text-[13px] text-faint hover:text-dim transition-colors"
              >
                <Sparkles size={14} className="text-gold/70" />
                Try without a streamer — explore with the built-in demo →
              </button>
            )}
          </div>
        </section>

        {/* ------------------------------------------------ streamer / tone & eq */}
        {/* One tabbed section when the device has tone controls (both panels
            visible without scrolling); the plain streamer card otherwise.
            "Streamer" is a generic label, not the device's name — the info
            rows inside carry the actual name. */}
        {systemInfo && connectedHost && (
          <section className="space-y-3">
            {hasToneTab ? (
              <Segmented
                value={activeTab}
                onChange={(deviceTab) => void saveSettings({ deviceTab })}
                options={[
                  { value: 'streamer' as const, label: 'Streamer' },
                  { value: 'tone' as const, label: 'Tone & EQ' }
                ]}
                className="w-fit"
              />
            ) : (
              <div className="microlabel">streamer</div>
            )}
            <div
              className={cx(
                'rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-3',
                activeTab !== 'streamer' && 'hidden'
              )}
            >
              <InfoRow label="Name" value={systemInfo.name} />
              <InfoRow label="Model" value={systemInfo.model} />
              <InfoRow label="Unit ID" value={systemInfo.unit_id} mono />
              <InfoRow label="API version" value={systemInfo.api} mono />
              {(systemInfo.versions ?? []).map((v) => (
                <InfoRow
                  key={v.component ?? ''}
                  label={`Firmware · ${v.component ?? '?'}`}
                  value={v.version}
                  mono
                />
              ))}

              {/* Passive firmware indicator: informational only. No check/install
                  control — the streamer reports its own self-check and updating
                  is done in the Cambridge Audio app or the web admin below. */}
              {firmwareUpdate?.updating ? (
                <div className="flex items-start gap-2.5 rounded-lg ring-1 ring-gold/40 bg-golddim px-3 py-2.5">
                  <Loader2 size={14} className="spin text-gold shrink-0 mt-px" />
                  <div className="min-w-0">
                    <div className="text-[12.5px] text-gold">Updating firmware…</div>
                    <div className="text-[11px] text-faint mt-0.5">
                      The streamer is installing an update. Leave it powered on until it finishes.
                    </div>
                  </div>
                </div>
              ) : firmwareUpdate?.updateAvailable ? (
                <div className="flex items-start gap-2.5 rounded-lg ring-1 ring-gold/40 bg-golddim px-3 py-2.5">
                  <ArrowUpCircle size={14} className="text-gold shrink-0 mt-px" />
                  <div className="min-w-0">
                    <div className="text-[12.5px] text-gold">Firmware update available</div>
                    <div className="text-[11px] text-faint mt-0.5">
                      Install it in the Cambridge Audio app or the streamer&rsquo;s web admin below —
                      TastyTunes never updates firmware itself.
                    </div>
                  </div>
                </div>
              ) : firmwareUpdate ? (
                // Calm positive confirmation (not gold — this is the normal state),
                // so the user gets the same "you're up to date" reassurance the
                // streamer's own web page gives.
                <div className="flex items-center gap-2 text-[12px] text-dim">
                  <Check size={13} strokeWidth={2.5} className="text-led shrink-0" />
                  Firmware up to date
                </div>
              ) : null}

              {/* §10 controls — brightness / standby / auto power-down, each
                  feature-detected via its /spec (hidden on models without it) */}
              <DeviceControls />

              {/* the demo device has no web interface to point at */}
              {!(connection.phase === 'connected' && connection.demo) && (
                <div className="pt-1 border-t border-edge">
                  <button
                    onClick={() => void tt.openExternal(`http://${connectedHost}`)}
                    className="mt-3 flex items-center gap-1.5 text-[12.5px] px-3 h-8 rounded-lg ring-1 ring-edge bg-panel/70 text-amber hover:brightness-110 hover:ring-edge2 motion-safe:active:scale-95 transition-all"
                  >
                    Open web admin <ExternalLink size={12} />
                  </button>
                  <div className="text-[11.5px] text-faint mt-1.5">
                    Renaming and firmware updates live in the streamer&rsquo;s own web interface.
                  </div>
                </div>
              )}
            </div>
            {/* feature-detected: ToneEq renders null on streamers whose
                /zone/audio/spec offers no writable controls */}
            {activeTab === 'tone' && <ToneEq label={false} />}
          </section>
        )}

        <div className="microlabel">
          press <span className="text-dim">`</span> for the smoip payload console
        </div>
        </div>
      </div>
    </div>
  )
}

function InfoRow({
  label,
  value,
  mono
}: {
  label: string
  value: string | null | undefined
  mono?: boolean
}): React.JSX.Element | null {
  if (!value) return null
  return (
    <div className="flex items-baseline gap-4">
      <span className="text-[12px] text-faint w-36 shrink-0">{label}</span>
      <span className={cx('text-[12.5px] text-ink/90 break-all', mono && 'font-mono text-[11.5px]')}>
        {value}
      </span>
    </div>
  )
}
