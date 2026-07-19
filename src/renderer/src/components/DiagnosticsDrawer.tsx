import { useEffect, useRef, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, Pause, Play } from 'lucide-react'
import { useStore } from '@/store'
import { cx } from '@/lib/format'
import { CloseButton } from '@/components/CloseButton'

type Filter = 'all' | 'in' | 'out' | 'logs'

type Tab = 'smoip' | 'requests'

export function DiagnosticsDrawer(): React.JSX.Element {
  const frames = useStore((s) => s.frames)
  const saveSettings = useStore((s) => s.saveSettings)
  const logs = useStore((s) => s.logs)
  const netRequests = useStore((s) => s.netRequests)
  const setDiagnosticsOpen = useStore((s) => s.setDiagnosticsOpen)
  const settings = useStore((s) => s.settings)
  // Last-selected tab persists; switch locally first so it feels instant.
  const [tab, setTab] = useState<Tab>(() =>
    settings.diagnosticsTab === 'requests' ? 'requests' : 'smoip'
  )
  const selectTab = (id: Tab): void => {
    setTab(id)
    void saveSettings({ diagnosticsTab: id })
  }
  const [filter, setFilter] = useState<Filter>('all')
  const [paused, setPaused] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!paused && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [frames, logs, netRequests, paused, filter, tab])

  const rows =
    filter === 'logs'
      ? logs.map((l) => ({ key: `log-${l.at}-${l.text}`, at: l.at, log: l, frame: null as never | null }))
      : frames
          .filter((f) => filter === 'all' || f.dir === filter)
          .filter((f) => f.frame.path !== '/zone/play_state/position') // 1 Hz noise
          .map((f, i) => ({ key: `f-${f.at}-${i}`, at: f.at, log: null, frame: f }))

  return (
    <div className="absolute inset-x-0 bottom-0 h-72 bg-panel border-t border-edge2 flex flex-col z-20 shadow-[0_-16px_50px_rgb(0_0_0_/_0.5)]">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-edge">
        {(
          [
            ['smoip', 'smoip console'],
            ['requests', 'requests']
          ] as Array<[Tab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => selectTab(id)}
            className={cx(
              'microlabel px-2 py-0.5 rounded transition-colors',
              tab === id ? 'bg-amberdim text-amber' : 'text-faint hover:text-dim'
            )}
          >
            {label}
          </button>
        ))}
        <div className="flex-1" />
        {tab === 'smoip' &&
          (['all', 'in', 'out', 'logs'] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cx(
                'font-mono text-[10px] uppercase px-2 py-0.5 rounded transition-colors',
                filter === f ? 'bg-amberdim text-amber' : 'text-faint hover:text-dim'
              )}
            >
              {f}
            </button>
          ))}
        <button
          onClick={() => setPaused((p) => !p)}
          className="p-1.5 text-faint hover:text-dim"
          title={paused ? 'Resume auto-scroll' : 'Pause auto-scroll'}
        >
          {paused ? <Play size={13} /> : <Pause size={13} />}
        </button>
        <CloseButton onClick={() => setDiagnosticsOpen(false)} size={14} />
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto font-mono text-[10.5px] px-3 py-2 select-text">
        {tab === 'requests' && (
          <>
            {netRequests.map((r) => (
              <div key={r.id} className="flex gap-2 py-[1px] items-baseline">
                <span className="text-faint shrink-0">{time(r.at)}</span>
                <span className="text-gold/80 shrink-0 w-24 truncate">{r.service}</span>
                <span className="text-faint shrink-0">{r.method}</span>
                <span className="text-dim truncate flex-1 min-w-0">
                  {r.url.replace(/^https?:\/\//, '')}
                </span>
                {r.error ? (
                  <span className="text-alert shrink-0">FAIL</span>
                ) : r.status == null ? (
                  <span className="text-amber shrink-0 motion-safe:animate-pulse">…</span>
                ) : (
                  <span className={cx('shrink-0', r.status < 400 ? 'text-led' : 'text-alert')}>
                    {r.status}
                  </span>
                )}
                <span className="text-faint shrink-0 w-14 text-right">
                  {r.ms != null ? `${r.ms}ms` : ''}
                </span>
              </div>
            ))}
            {netRequests.length === 0 && (
              <div className="text-faint py-2">
                No outbound requests yet — lyrics, artist info, scrobbles, and update checks land
                here.
              </div>
            )}
          </>
        )}
        {tab === 'smoip' &&
          rows.map((row, i) =>
          row.log ? (
            <div key={row.key} className="flex gap-2 py-[1px]">
              <span className="text-faint shrink-0">{time(row.at)}</span>
              <span
                className={cx(
                  'shrink-0 uppercase',
                  row.log.level === 'error'
                    ? 'text-alert'
                    : row.log.level === 'warn'
                      ? 'text-amber'
                      : 'text-faint'
                )}
              >
                {row.log.level}
              </span>
              <span className="text-faint shrink-0">[{row.log.scope}]</span>
              <span className="text-dim break-all">{row.log.text}</span>
            </div>
          ) : row.frame ? (
            <div
              key={row.key}
              className="py-[1px] cursor-pointer hover:bg-veil rounded"
              onClick={() => setExpanded(expanded === i ? null : i)}
            >
              <div className="flex gap-2">
                <span className="text-faint shrink-0">{time(row.at)}</span>
                {row.frame.dir === 'out' ? (
                  <ArrowUpRight size={12} className="text-amber shrink-0 mt-[1px]" />
                ) : (
                  <ArrowDownLeft size={12} className="text-led shrink-0 mt-[1px]" />
                )}
                <span className={cx('shrink-0', row.frame.dir === 'out' ? 'text-amber' : 'text-ink/80')}>
                  {row.frame.frame.path}
                </span>
                <span className="text-faint truncate">
                  {expanded === i ? '' : JSON.stringify(row.frame.frame.params ?? {})}
                </span>
              </div>
              {expanded === i && (
                <pre className="text-dim whitespace-pre-wrap break-all pl-6 py-1">
                  {JSON.stringify(row.frame.frame, null, 2)}
                </pre>
              )}
            </div>
          ) : null
        )}
        {tab === 'smoip' && rows.length === 0 && (
          <div className="text-faint py-2">Nothing captured yet.</div>
        )}
      </div>
    </div>
  )
}

function time(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}
