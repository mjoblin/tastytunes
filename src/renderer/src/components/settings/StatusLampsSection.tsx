// THE STATUS LAMPS TAB (moved out of SettingsScreen.tsx as it was, 0.16.0's tidy before the design pass:
// each tab its own section, as Libraries, History, Updates, Schedules and AI agents already were).
import { SignalDot } from "@/components/device/SignalLamp";
import { LegendRow, SettingsCard } from "@/components/settings/SettingsKit";

export function StatusLampsSection(): React.JSX.Element {
  return (
    <section className="space-y-3">
      <SettingsCard>
        <div>
          <div className="text-[13.5px] mb-0.5">Connection</div>
          <div className="text-[11.5px] text-faint mb-2.5">
            Shown beside each streamer in the device picker and on the Device screen.
          </div>
          <div className="space-y-2">
            <LegendRow
              swatch={<span className="led led-on" />}
              label="Connected"
              desc="Live link to the streamer."
            />
            <LegendRow
              swatch={<span className="led led-busy" />}
              label="Connecting"
              desc="Establishing or re-establishing the connection."
            />
            <LegendRow
              swatch={<span className="led led-off" />}
              label="Offline"
              desc="No connection to a streamer."
            />
          </div>
        </div>

        <div>
          <div className="text-[13.5px] mb-0.5">Signal quality</div>
          <div className="text-[11.5px] text-faint mb-2.5">
            Appears in the transport bar and beside the Now Playing badges while something is
            playing. Click it for the full signal chain.
          </div>
          <div className="space-y-2">
            <LegendRow
              swatch={<SignalDot quality="hires" />}
              label="Hi-res lossless"
              desc="Lossless above CD quality (or MQA)."
            />
            <LegendRow
              swatch={<SignalDot quality="lossless" />}
              label="Lossless"
              desc="Bit-perfect CD quality."
            />
            <LegendRow
              swatch={<SignalDot quality="lossy" />}
              label="Lossy"
              desc="Compressed stream (internet radio, Bluetooth, AAC/MP3)."
            />
          </div>
        </div>
      </SettingsCard>
    </section>
  );
}
