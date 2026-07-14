import { useState } from 'react'
import { Loader2, MonitorSpeaker, RefreshCw } from 'lucide-react'
import { tt } from '@/api'
import { useStore } from '@/store'
import { cx } from '@/lib/format'

/** Roon-zone-style device picker, right in the playback bar. */
export function DeviceSwitcher(): React.JSX.Element {
  const connection = useStore((s) => s.connection)
  const devices = useStore((s) => s.devices)
  const discovering = useStore((s) => s.discovering)
  const systemInfo = useStore((s) => s.systemInfo)
  const [open, setOpen] = useState(false)

  const connectedHost = connection.phase === 'connected' ? connection.host : null
  const busyHost =
    connection.phase === 'connecting'
      ? connection.host
      : connection.phase === 'disconnected' && connection.reconnecting
        ? connection.host
        : null

  // The connected device may have been connected manually and never discovered.
  const listed = [...devices]
  if (connectedHost && !listed.some((d) => d.host === connectedHost)) {
    listed.unshift({
      host: connectedHost,
      friendlyName: systemInfo?.name ?? connectedHost,
      model: systemInfo?.model ?? '',
      udn: systemInfo?.udn ?? '',
      descriptionUrl: ''
    })
  }

  return (
    <div className="relative">
      <button
        data-tip="Streamers"
        aria-label="Streamers"
        onClick={() => setOpen((o) => !o)}
        className={cx(
          'tip-top p-2 rounded-md transition-colors',
          open ? 'text-gold bg-golddim' : 'text-dim hover:text-ink hover:bg-veil'
        )}
      >
        <MonitorSpeaker size={16} strokeWidth={1.8} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute bottom-11 right-0 z-40 w-72 rounded-xl bg-raised ring-1 ring-edge2 shadow-2xl p-2">
            <div className="flex items-center justify-between px-2 pt-1.5 pb-2">
              <span className="microlabel">streamers</span>
              <button
                title="Find devices"
                onClick={() => void tt.discover()}
                disabled={discovering}
                className="p-1 text-faint hover:text-gold transition-colors disabled:opacity-50"
              >
                {discovering ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
              </button>
            </div>

            {listed.length === 0 && (
              <div className="px-2 pb-2 text-[12px] text-faint">
                {discovering ? 'Searching the network…' : 'No streamers found.'}
              </div>
            )}

            {listed.map((device) => {
              const isConnected = device.host === connectedHost
              const isBusy = device.host === busyHost
              return (
                <button
                  key={device.udn || device.host}
                  onClick={() => {
                    if (!isConnected) void tt.connect(device.host)
                    setOpen(false)
                  }}
                  className={cx(
                    'w-full flex items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors',
                    isConnected ? 'bg-gold/10' : 'hover:bg-veil'
                  )}
                >
                  <span className={cx('led', isConnected ? 'led-on' : isBusy ? 'led-busy' : 'led-off')} />
                  <span className="flex-1 min-w-0">
                    <span className={cx('block text-[13px] truncate', isConnected ? 'text-gold' : 'text-ink')}>
                      {device.friendlyName}
                    </span>
                    <span className="block font-mono text-[10px] text-faint truncate">
                      {[device.model, device.host].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
