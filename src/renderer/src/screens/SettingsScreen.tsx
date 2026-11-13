import { useState } from "react";
import {
  AlarmClock,
  ArrowUpCircle,
  Plug,
  Globe,
  Heart,
  History,
  Library,
  Palette,
  SlidersHorizontal,
} from "lucide-react";
import { version } from "../../../../package.json";
import { useStore } from "@/store";
import { useScrollMemory } from "@/hooks/useScrollMemory";
import { cx } from "@/lib/format";
import { PrimaryButton, ScreenTitle } from "@/components/chrome/Chrome";
import { useOneShotAsk } from "@/hooks/useOneShotAsk";
import { AppearanceSection } from "@/components/settings/AppearanceSection";
import { BehaviorSection } from "@/components/settings/BehaviorSection";
import { ConnectionsSection } from "@/components/settings/ConnectionsSection";
import { LibrariesSection } from "@/components/settings/LibrariesSection";
import { HistorySection } from "@/components/settings/HistorySection";
import { UpdatesSection } from "@/components/settings/UpdatesSection";
import { SchedulesSection } from "@/components/settings/SchedulesSection";
import { IntegrationsSection } from "@/components/settings/IntegrationsSection";
import { type SectionProps } from "@/components/settings/SettingsKit";

const TABS = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "behavior", label: "Behavior", icon: SlidersHorizontal },
  { id: "connections", label: "Connections", icon: Globe },
  { id: "libraries", label: "Libraries", icon: Library },
  { id: "history", label: "History", icon: History },
  { id: "updates", label: "Updates", icon: ArrowUpCircle },
  { id: "schedules", label: "Schedules", icon: AlarmClock },
  { id: "integrations", label: "Integrations", icon: Plug },
] as const;
type SettingsTab = (typeof TABS)[number]["id"];
/** Tabs kept under an older id (0.16.0's settings diet: AI agents became Integrations). */
const RENAMED_TABS: Partial<Record<string, SettingsTab>> = { agents: "integrations" };

/** Each tab's section, keyed by the tab: a tab can't exist without its section, nor a section
 *  without its tab (0.16.0's tidy; before, the tab list and a chain of `tab === …` renders had
 *  to agree by hand). */
const PANELS: Record<SettingsTab, (props: SectionProps) => React.JSX.Element> = {
  appearance: AppearanceSection,
  behavior: BehaviorSection,
  connections: ConnectionsSection,
  libraries: LibrariesSection,
  history: HistorySection,
  updates: UpdatesSection,
  schedules: SchedulesSection,
  integrations: IntegrationsSection,
};

export function SettingsScreen(): React.JSX.Element {
  const settings = useStore((s) => s.settings);
  const setInfoOpen = useStore((s) => s.setInfoOpen);

  const save = useStore((s) => s.saveSettings);

  // Last-visited tab persists; switch locally first so the rail feels instant. A tab saved under its
  // old id opens under its new one, and a retired tab (Layout, Status lamps) opens Appearance.
  const [tab, setTab] = useState<SettingsTab>(() => {
    const id = RENAMED_TABS[settings.settingsTab] ?? settings.settingsTab;
    return TABS.some((t) => t.id === id) ? (id as SettingsTab) : "appearance";
  });
  const selectTab = (id: SettingsTab): void => {
    setTab(id);
    void save({ settingsTab: id });
  };
  const panelRef = useScrollMemory(`settings:${tab}`);
  const Panel = PANELS[tab];

  const update = useStore((s) => s.update);
  // One-shot deep link (the nav update dot lands on Updates); consume + clear.
  const settingsJump = useStore((s) => s.settingsJump);
  const clearSettingsJump = useStore((s) => s.clearSettingsJump);
  useOneShotAsk(
    settingsJump,
    (tab) => {
      if (TABS.some((t) => t.id === tab)) selectTab(tab as SettingsTab);
    },
    { clear: clearSettingsJump },
  );

  return (
    <div className="h-full flex flex-col">
      <header className="drag-region flex items-center gap-4 px-8 pt-8 pb-4">
        <ScreenTitle>Settings</ScreenTitle>
        <span className="font-mono text-[11px] text-faint">saved automatically</span>
        <div className="flex-1" />
        <PrimaryButton
          onClick={() => setInfoOpen(true)}
          className="no-drag flex items-center gap-2 px-3.5 py-2 text-[12.5px] motion-safe:hover:scale-[1.03]"
        >
          <Heart size={15} strokeWidth={2} />
          Info &amp; Support
        </PrimaryButton>
      </header>

      {/* pinned header + tab rail; only the per-tab panel scrolls */}
      <div className="flex-1 min-h-0 flex gap-5 px-8 pb-8 pt-1">
        <nav className="w-44 shrink-0 space-y-0.5" data-settings-rail>
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => selectTab(id)}
              aria-current={tab === id ? "page" : undefined}
              className={cx(
                "w-full flex items-center gap-3 rounded-lg h-9 px-3 text-[13.5px] transition-colors",
                tab === id ? "bg-accentdim text-accent" : "text-dim hover:text-ink hover:bg-veil",
              )}
            >
              <Icon size={15} strokeWidth={1.8} className="shrink-0" />
              <span className="flex-1 text-left">{label}</span>
              {id === "updates" && update && (
                <span
                  aria-label="Update available"
                  className="w-1.5 h-1.5 rounded-full bg-gold shrink-0"
                />
              )}
            </button>
          ))}

          {/* The version, where it's visible from every tab rather than only
              from Updates (and the About box). The rail is pinned while the
              panel scrolls, so this never moves; it opens Updates, which is
              where the version row and the check-now button already live. */}
          <button
            onClick={() => selectTab("updates")}
            title="Open Updates"
            className="w-full px-3 pt-6 text-left font-mono text-[11px] text-faint hover:text-dim"
          >
            v{version}
          </button>
        </nav>

        {/* keyed by tab so each tab keeps its own scroll position */}
        {/* p-px: the cards' 1px ring must not sit flush against the scrollport,
            or it clips when the panel narrows to exactly max-w-2xl */}
        <div
          key={tab}
          ref={panelRef}
          className="flex-1 min-w-0 overflow-y-auto p-px pb-10 fade-bottom"
        >
          <div className="max-w-2xl space-y-8">
            <Panel settings={settings} save={save} />
          </div>
        </div>
      </div>
    </div>
  );
}
