// THE LAYOUT TAB (moved out of SettingsScreen.tsx as it was, 0.16.0's tidy before the design pass:
// each tab its own section, as Libraries, History, Updates, Schedules and AI agents already were).
import { CARD_GAP_RANGE, CARD_SIZE_RANGE } from "@shared/model";
import { SidebarSection } from "@/components/settings/SidebarSection";
import {
  SettingsCard,
  SliderSetting,
  Toggle,
  type SectionProps,
} from "@/components/settings/SettingsKit";

export function LayoutSection({ settings, save }: SectionProps): React.JSX.Element {
  return (
    <>
      <section className="space-y-3">
        <div className="microlabel">card grids</div>
        <SettingsCard>
          <SliderSetting
            label="Card size"
            hint="Base width of each card."
            min={CARD_SIZE_RANGE.min}
            max={CARD_SIZE_RANGE.max}
            unit="px"
            value={settings.presetCardSize}
            onCommit={(presetCardSize) => void save({ presetCardSize })}
          />

          <SliderSetting
            label="Card gap"
            hint="Space between cards."
            min={CARD_GAP_RANGE.min}
            max={CARD_GAP_RANGE.max}
            unit="px"
            value={settings.presetGap}
            onCommit={(presetGap) => void save({ presetGap })}
          />

          <Toggle
            label="Fill rows"
            hint="Stretch cards so each row spans the full width, sizes flexing with the window. Off keeps cards at the exact size above."
            checked={settings.presetFillRows}
            onChange={(presetFillRows) => void save({ presetFillRows })}
          />

          <Toggle
            label="Format and DR on album cards"
            hint="Displays each album's format and quality under its name wherever albums are shown as cards, and its dynamic range once Audio analysis has measured it."
            checked={settings.albumCardFormat}
            onChange={(albumCardFormat) => void save({ albumCardFormat })}
          />

          <Toggle
            label="Format and DR on track cards"
            hint="Displays each track's format and quality under its name in the Tracks view, and its dynamic range once Audio analysis has measured it."
            checked={settings.trackCardFormat}
            onChange={(trackCardFormat) => void save({ trackCardFormat })}
          />
        </SettingsCard>
      </section>

      <SidebarSection />
    </>
  );
}
