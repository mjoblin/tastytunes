import { useEffect } from 'react'
import type { SleepAction } from '@shared/ipc'
import type { ZonePlayState } from '@shared/smoip'
import { tt } from '@/api'
import { useStore } from '@/store'

/**
 * Identity of the currently-playing track, used to detect the boundary for an
 * "end of track" sleep timer. Queue playback gives us a stable per-item id;
 * other sources (AirPlay, USB) fall back to title/artist. Returns null when
 * nothing identifiable is playing.
 */
export function currentTrackKey(ps: ZonePlayState | null): string | null {
  if (!ps) return null
  if (ps.queue_id != null) return `q${ps.queue_id}`
  const md = ps.metadata
  if (md?.title) return `t:${md.title}:${md.artist ?? ''}`
  return null
}

function fire(action: SleepAction): void {
  const s = useStore.getState()
  // Only touch the streamer if we're still connected — a timer that expires
  // after a dropout should quietly clear, never pause on reconnect.
  if (s.connection.phase === 'connected') {
    if (action === 'standby') void tt.command({ type: 'power', power: 'NETWORK' })
    else void tt.command({ type: 'pause' })
  }
  s.setSleep(null)
}

/**
 * Drives the live sleep timer (state lives in the store; the UI is in the
 * playback bar). Mounted once, always, so it keeps running as the user moves
 * between screens or closes the timer popover.
 */
export function useSleepTimer(): void {
  const sleep = useStore((s) => s.sleep)
  const playState = useStore((s) => s.playState)
  const connectionPhase = useStore((s) => s.connection.phase)

  // Duration countdown → fire on a plain timeout.
  useEffect(() => {
    if (!sleep || sleep.firesAt == null) return
    const ms = sleep.firesAt - Date.now()
    if (ms <= 0) {
      fire(sleep.action)
      return
    }
    const t = setTimeout(() => fire(sleep.action), ms)
    return () => clearTimeout(t)
  }, [sleep])

  // "End of track" → fire when the armed track gives way to another, or when
  // playback ends outright.
  useEffect(() => {
    if (!sleep || sleep.minutes != null) return
    const state = playState?.state
    const key = currentTrackKey(playState)
    const advanced = sleep.trackKey != null && key != null && key !== sleep.trackKey
    const ended = state === 'stop' || state === 'no_signal'
    if (advanced || ended) fire(sleep.action)
  }, [sleep, playState])

  // Losing the device entirely (explicit disconnect / device switch) drops the
  // timer; a transient reconnect keeps it.
  useEffect(() => {
    if (sleep && connectionPhase === 'idle') useStore.getState().setSleep(null)
  }, [sleep, connectionPhase])
}
