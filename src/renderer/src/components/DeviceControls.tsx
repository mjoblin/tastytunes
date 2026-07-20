import { tt } from '@/api'
import { useStore } from '@/store'
import { Segmented } from '@/components/Segmented'
import { autoPowerDownRange, brightnessOptions, standbyModeOptions } from '@shared/smoip'

// §10 device controls on the Device screen's Streamer tab: front-panel
// brightness, standby mode, and auto power-down. Each renders only when its
// /spec field is present and writable (feature-detected — a headless streamer
// has no /system/display, so brightness simply doesn't appear). Writes push
// /system/display or /system/power back, so the segments reflect the device
// (and external changes from the web admin) live.

const BRIGHTNESS_LABEL: Record<string, string> = { off: 'Off', dim: 'Dim', bright: 'Bright' }
// ECO_MODE = deep low-power standby; NETWORK = network standby (instant-on).
const STANDBY_LABEL: Record<string, string> = { ECO_MODE: 'Eco', NETWORK: 'Network' }
const STANDBY_TIP: Record<string, string> = {
  ECO_MODE: 'Lowest power; slower to wake',
  NETWORK: 'Stays network-reachable; instant-on'
}
const POWER_DOWN_PRESETS = [
  { seconds: 0, label: 'Never' },
  { seconds: 900, label: '15 min' },
  { seconds: 1800, label: '30 min' },
  { seconds: 3600, label: '1 hour' },
  { seconds: 7200, label: '2 hours' }
]

/** Snap the device's reported auto-power-down to the nearest offered preset so
 *  one segment is always highlighted (a web-admin value need not match ours).
 *  When the snap is inexact, the row annotates the device's true value — the
 *  highlight alone must not misreport what the streamer is actually set to. */
const nearestPreset = (secs: number, presets: number[]): number =>
  presets.reduce((best, p) => (Math.abs(p - secs) < Math.abs(best - secs) ? p : best), presets[0])

/** Human form of an off-preset auto-power-down value (range is 0..2h, so
 *  minutes cover everything the presets don't). */
const formatPowerDown = (secs: number): string =>
  secs === 0 ? 'never' : secs % 3600 === 0 ? `${secs / 3600} h` : `${Math.round(secs / 60)} min`

export function DeviceControls(): React.JSX.Element | null {
  const display = useStore((s) => s.systemDisplay)
  const displaySpec = useStore((s) => s.displaySpec)
  const power = useStore((s) => s.systemPower)
  const powerSpec = useStore((s) => s.powerSpec)

  const brightness = brightnessOptions(displaySpec)
  const standby = standbyModeOptions(powerSpec)
  const powerDown = autoPowerDownRange(powerSpec)

  if (!brightness && !standby && !powerDown) return null

  const powerDownOptions = powerDown
    ? POWER_DOWN_PRESETS.filter((p) => p.seconds >= powerDown.min && p.seconds <= powerDown.max)
    : []
  const powerDownActual = power?.auto_power_down ?? 0
  const powerDownSnapped = powerDownOptions.length
    ? nearestPreset(
        powerDownActual,
        powerDownOptions.map((p) => p.seconds)
      )
    : 0

  return (
    <div className="border-t border-edge pt-3.5 space-y-3.5" data-device-controls>
      {brightness && display && (
        <ControlRow label="Display">
          <Segmented
            value={display.brightness}
            onChange={(b) => void tt.command({ type: 'setBrightness', brightness: b })}
            options={brightness.map((b) => ({ value: b, label: BRIGHTNESS_LABEL[b] ?? b }))}
          />
        </ControlRow>
      )}

      {standby && power && (
        <ControlRow label="Standby">
          <Segmented
            value={power.standby_mode ?? standby[0]}
            onChange={(m) => void tt.command({ type: 'setStandbyMode', mode: m })}
            options={standby.map((m) => ({
              value: m,
              label: STANDBY_LABEL[m] ?? m,
              tip: STANDBY_TIP[m]
            }))}
          />
        </ControlRow>
      )}

      {powerDown && power && powerDownOptions.length > 0 && (
        <ControlRow label="Auto power-down">
          <div className="flex items-center gap-2.5">
            <Segmented
              value={powerDownSnapped}
              onChange={(secs) => void tt.command({ type: 'setAutoPowerDown', seconds: secs })}
              options={powerDownOptions.map((p) => ({ value: p.seconds, label: p.label }))}
            />
            {powerDownSnapped !== powerDownActual && (
              <span className="text-[11px] text-faint whitespace-nowrap" data-apd-note>
                device: {formatPowerDown(powerDownActual)}
              </span>
            )}
          </div>
        </ControlRow>
      )}
    </div>
  )
}

function ControlRow({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-4">
      <span className="text-[12px] text-faint w-28 shrink-0">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}
