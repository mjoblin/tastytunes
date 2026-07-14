import { useState } from 'react'
import { ExternalLink, Loader2, RefreshCw, Unplug } from 'lucide-react'
import { tt } from '@/api'
import { useStore } from '@/store'
import { useScrollMemory } from '@/hooks/useScrollMemory'
import { cx } from '@/lib/format'

export function DeviceScreen(): React.JSX.Element {
  const connection = useStore((s) => s.connection)
  const devices = useStore((s) => s.devices)
  const discovering = useStore((s) => s.discovering)
  const systemInfo = useStore((s) => s.systemInfo)
  const [manualHost, setManualHost] = useState('')

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
        return `Connected to ${connection.host}`
      case 'disconnected':
        return connection.reconnecting
          ? `Lost connection to ${connection.host} (${connection.reason}) — reconnecting…`
          : `Disconnected from ${connection.host}`
    }
  })()

  return (
    <div ref={useScrollMemory('device')} className="h-full overflow-y-auto">
      <header className="flex items-center gap-4 px-8 pt-8 pb-4">
        <h1 className="font-display font-bold text-[26px] tracking-tight">Device</h1>
      </header>

      <div className="px-8 pb-10 max-w-2xl space-y-8">
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
                  className="flex items-center gap-1.5 text-[12px] text-faint hover:text-dim px-2 py-1 rounded transition-colors"
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
                  className="flex items-center gap-1.5 text-[12px] text-amber hover:brightness-110 px-2 py-1 rounded transition-all disabled:opacity-50"
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
                      className="text-[12px] text-amber hover:brightness-110 px-2 py-1"
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
          </div>
        </section>

        {/* -------------------------------------------------------------- streamer */}
        {systemInfo && connectedHost && (
          <section className="space-y-3">
            <div className="microlabel">streamer</div>
            <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 space-y-3">
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
              <div className="pt-1">
                <button
                  onClick={() => void tt.openExternal(`http://${connectedHost}`)}
                  className="flex items-center gap-1.5 text-[12.5px] text-amber hover:brightness-110 transition-all"
                >
                  Open web admin <ExternalLink size={12} />
                </button>
                <div className="text-[11.5px] text-faint mt-1">
                  Rename, display brightness, standby modes, and firmware updates live in the
                  streamer's own web interface.
                </div>
              </div>
            </div>
          </section>
        )}

        <div className="microlabel">
          press <span className="text-dim">`</span> for the smoip payload console
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
