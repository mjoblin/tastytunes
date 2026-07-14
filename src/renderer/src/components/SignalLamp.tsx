import { useState } from 'react'
import { useStore } from '@/store'
import { SIGNAL_COLORS, SIGNAL_LABELS, cx, fmtKHz, signalQuality } from '@/lib/format'

/**
 * Roon-style signal light: one glance says how good the stream is; a click shows
 * the whole chain the streamer reports. Colors are fixed (not the art accent) so
 * quality always reads the same.
 */
export function SignalLamp(): React.JSX.Element | null {
  const playState = useStore((s) => s.playState)
  const nowPlaying = useStore((s) => s.nowPlaying)
  const [open, setOpen] = useState(false)

  const quality = signalQuality(playState)
  if (quality === 'unknown') return null

  const md = playState?.metadata
  const color = SIGNAL_COLORS[quality]

  const rows: Array<[string, string]> = []
  if (nowPlaying?.source?.name) rows.push(['Source', nowPlaying.source.name])
  if (md?.codec) rows.push(['Codec', md.codec])
  if (md?.sample_rate) rows.push(['Sample rate', fmtKHz(md.sample_rate)])
  if (md?.bit_depth) rows.push(['Bit depth', `${md.bit_depth}-bit`])
  if (md?.bitrate) rows.push(['Bitrate', `${Math.round(md.bitrate / 1000)} kbps`])
  rows.push(['Lossless', md?.lossless ? 'yes' : 'no'])
  if (md?.mqa && md.mqa !== 'none') rows.push(['MQA', md.mqa])

  return (
    <div className="relative">
      <button
        data-tip={open ? undefined : `Signal: ${SIGNAL_LABELS[quality]}`}
        aria-label={`Signal: ${SIGNAL_LABELS[quality]}`}
        onClick={() => setOpen((o) => !o)}
        className="tip-top p-2 rounded-md hover:bg-veil transition-colors"
      >
        <span
          className="block h-2.5 w-2.5 rounded-full"
          style={{ background: color, boxShadow: `0 0 8px ${color}b0` }}
        />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute bottom-11 right-0 z-40 w-60 rounded-xl bg-raised ring-1 ring-edge2 shadow-2xl p-3">
            <div className="flex items-center gap-2 mb-2.5">
              <span
                className="block h-2 w-2 rounded-full"
                style={{ background: color, boxShadow: `0 0 6px ${color}b0` }}
              />
              <span className={cx('microlabel')} style={{ color }}>
                {SIGNAL_LABELS[quality]}
              </span>
            </div>
            <div className="space-y-1.5">
              {rows.map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-3">
                  <span className="text-[11px] text-faint">{label}</span>
                  <span className="font-mono text-[11px] text-ink/90">{value}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
