import { useEffect, useRef, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, Pause, Play, X } from 'lucide-react'
import { useStore } from '@/store'
import { cx } from '@/lib/format'

type Filter = 'all' | 'in' | 'out' | 'logs'

export function DiagnosticsDrawer(): React.JSX.Element {
  const frames = useStore((s) => s.frames)
  const logs = useStore((s) => s.logs)
  const setDiagnosticsOpen = useStore((s) => s.setDiagnosticsOpen)
  const [filter, setFilter] = useState<Filter>('all')
  const [paused, setPaused] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!paused && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [frames, logs, paused, filter])

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
        <span className="microlabel">smoip console</span>
        <div className="flex-1" />
        {(['all', 'in', 'out', 'logs'] as Filter[]).map((f) => (
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
        <button onClick={() => setDiagnosticsOpen(false)} className="p-1.5 text-faint hover:text-dim">
          <X size={14} />
        </button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto font-mono text-[10.5px] px-3 py-2 select-text">
        {rows.map((row, i) =>
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
        {rows.length === 0 && <div className="text-faint py-2">Nothing captured yet.</div>}
      </div>
    </div>
  )
}

function time(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}
