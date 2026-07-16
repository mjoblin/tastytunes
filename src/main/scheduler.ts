// Scheduled actions (alarms). A 15s tick matches enabled schedules against
// the local clock; each fires at most once per minute-instance. Honest scope:
// alarms fire only while the app is running — the UI says so. A schedule that
// matches while the streamer is disconnected retries on later ticks within
// its minute (device may reconnect mid-minute) but is never fired late.
import type { Schedule } from '@shared/ipc'
import type { DeviceManager } from './deviceManager'
import { getSettings } from './persist'

const TICK_MS = 15_000

const lastFired = new Map<string, string>()

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function fire(dm: DeviceManager, s: Schedule): Promise<void> {
  const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  if (s.action === 'standby') {
    await dm.command({ type: 'power', power: 'NETWORK' })
    return
  }
  // Wake: power first (a no-op re-send is guarded off in DeviceManager), then
  // give the device a beat before the preset, and the preset before volume.
  await dm.command({ type: 'power', power: 'ON' })
  if (s.presetId != null) {
    await settle(2500)
    await dm.command({ type: 'recallPreset', presetId: s.presetId })
  }
  if (s.volumePercent != null) {
    await settle(1500)
    await dm.command({ type: 'setVolumePercent', percent: s.volumePercent })
  }
}

export function startScheduler(dm: DeviceManager): void {
  const check = (): void => {
    const now = new Date()
    const time = hhmm(now)
    const day = now.getDay()
    for (const s of getSettings().schedules) {
      if (!s.enabled || s.time !== time || !s.days.includes(day)) continue
      const instance = `${now.toDateString()} ${time}`
      if (lastFired.get(s.id) === instance) continue
      if (dm.snapshot().connection.phase !== 'connected') continue
      lastFired.set(s.id, instance)
      void fire(dm, s)
    }
  }
  setInterval(check, TICK_MS)
  // Startup check shortly after launch — late enough for the reconnect.
  setTimeout(check, 3_000)
}
