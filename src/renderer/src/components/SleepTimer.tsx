import { useEffect, useState } from 'react'
import { Moon } from 'lucide-react'
import { sleepTrackKey, type SleepAction } from '@shared/ipc'
import { tt } from '@/api'
import { useStore } from '@/store'
import { cx, deriveNowPlaying, fmtTime } from '@/lib/format'

const DURATIONS: Array<{ minutes: number; label: string }> = [
  { minutes: 15, label: '15 min' },
  { minutes: 30, label: '30 min' },
  { minutes: 45, label: '45 min' },
  { minutes: 60, label: '1 hr' },
  { minutes: 90, label: '1.5 hr' },
  { minutes: 120, label: '2 hr' }
]

const ACTION_VERB: Record<SleepAction, string> = { pause: 'Pause', standby: 'Standby' }

/** Plexamp/Sonos-style sleep timer: pause or standby after a countdown, or at end of track. */
export function SleepTimer(): React.JSX.Element {
  const sleep = useStore((s) => s.sleep)
  const setSleepAction = useStore((s) => s.setSleepAction)
  const stored = useStore((s) => s.settings.sleepAction)
  const playState = useStore((s) => s.playState)
  const nowPlaying = useStore((s) => s.nowPlaying)
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // Never trust the stored value blindly — an older settings file (or a skewed
  // dev reload) can leave it unset, which would arm a timer with no action.
  const action: SleepAction = stored === 'pause' || stored === 'standby' ? stored : 'standby'
  const endOfTrack = sleep != null && sleep.minutes == null

  // Tick once a second while a countdown is live so the popover / tooltip stay fresh.
  useEffect(() => {
    if (sleep?.firesAt == null) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [sleep?.firesAt])

  const remainingSecs =
    sleep?.firesAt != null ? Math.max(0, Math.round((sleep.firesAt - now) / 1000)) : null

  const duration =
    playState?.metadata?.duration ?? nowPlaying?.display?.progress?.duration ?? null
  const meta = deriveNowPlaying(playState, nowPlaying)
  const canEndOfTrack =
    sleepTrackKey(playState) != null && duration != null && duration > 0 && !meta.isRadio

  // The timer itself lives in the main process (it must survive this window
  // closing); these calls arm/adjust it and the store mirrors its pushes.
  const arm = (minutes: number): void => {
    void tt.setSleep({ action, minutes, firesAt: Date.now() + minutes * 60_000, trackKey: null })
  }
  const armEndOfTrack = (): void => {
    void tt.setSleep({ action, minutes: null, firesAt: null, trackKey: sleepTrackKey(playState) })
  }
  const chooseAction = (next: SleepAction): void => {
    setSleepAction(next)
    void tt.setSettings({ sleepAction: next })
    if (sleep) void tt.setSleep({ ...sleep, action: next })
  }

  const statusLine = sleep
    ? sleep.minutes == null
      ? `${ACTION_VERB[sleep.action]} at end of track`
      : `${ACTION_VERB[sleep.action]} in ${fmtTime(remainingSecs)}`
    : null

  return (
    <div className="relative">
      <button
        data-tip={open ? undefined : (statusLine ?? 'Sleep timer')}
        aria-label={statusLine ?? 'Sleep timer'}
        onClick={() => setOpen((o) => !o)}
        className={cx(
          'tip-top p-2 rounded-md transition-colors',
          open || sleep ? 'text-gold bg-golddim' : 'text-dim hover:text-ink hover:bg-veil'
        )}
      >
        <Moon size={16} strokeWidth={1.9} fill={sleep ? 'currentColor' : 'none'} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute bottom-11 right-0 z-40 w-64 rounded-xl bg-raised ring-1 ring-edge2 shadow-2xl p-3">
            <div className="flex items-center justify-between mb-2.5">
              <span className="microlabel">sleep timer</span>
              <div className="flex rounded-md ring-1 ring-edge bg-bg p-0.5">
                {(['pause', 'standby'] as const).map((a) => (
                  <button
                    key={a}
                    onClick={() => chooseAction(a)}
                    className={cx(
                      'px-2 py-0.5 rounded text-[11px] capitalize transition-colors',
                      action === a ? 'bg-golddim text-gold' : 'text-dim hover:text-ink'
                    )}
                  >
                    {a}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-1.5">
              {DURATIONS.map(({ minutes, label }) => {
                const on = sleep?.minutes === minutes
                return (
                  <button
                    key={minutes}
                    onClick={() => arm(minutes)}
                    className={cx(
                      'rounded-lg py-2 text-[12px] transition-colors',
                      on ? 'bg-gold text-bg' : 'bg-veil text-dim hover:text-ink hover:bg-veil2'
                    )}
                  >
                    {label}
                  </button>
                )
              })}
              <button
                onClick={armEndOfTrack}
                disabled={!canEndOfTrack && !endOfTrack}
                className={cx(
                  'col-span-3 rounded-lg py-2 text-[12px] transition-colors',
                  endOfTrack
                    ? 'bg-gold text-bg'
                    : canEndOfTrack
                      ? 'bg-veil text-dim hover:text-ink hover:bg-veil2'
                      : 'bg-veil text-faint/40 cursor-not-allowed'
                )}
              >
                End of track
              </button>
            </div>

            {/* Always present so the popover height never jumps between states. */}
            <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-edge pt-2.5">
              <span className={cx('text-[11.5px]', sleep ? 'text-gold' : 'text-faint')}>
                {statusLine ?? 'Inactive'}
              </span>
              <button
                onClick={() => void tt.setSleep(null)}
                disabled={!sleep}
                className={cx(
                  'text-[11px] transition-colors',
                  sleep ? 'text-dim hover:text-ink' : 'text-faint/40 cursor-default'
                )}
              >
                Disable
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
