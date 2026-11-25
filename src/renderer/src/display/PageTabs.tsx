import { cx } from "@/lib/format";

/**
 * THE PAGE'S TABS (0.17.0, Display on other screens): one home for the two tab strips on the page,
 * the corner panel's Scene and Settings (display/ScenePanel) and the list's Queue and Presets
 * (display/PageTransport). Words at their own width, the chosen one in ink over a short accent
 * line, the other dim: a tab picks what the panel shows, and the gold-filled segmented look stays
 * the app's for a toggle that sets a value (controls/Segmented). A finger's height, 44px.
 */
export function PageTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: ReadonlyArray<{
    id: NoInfer<T>;
    label: string;
    icon?: React.ReactNode;
    /** data-* for harnesses. */
    attrs?: Record<string, string>;
  }>;
  value: T;
  onChange(id: T): void;
}): React.JSX.Element {
  return (
    <div role="tablist" className="flex min-w-0 items-center gap-1">
      {tabs.map((t) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            {...t.attrs}
            aria-selected={on}
            onClick={() => onChange(t.id)}
            className={cx(
              "relative flex h-11 shrink-0 items-center gap-2 px-3 text-[15px] font-medium transition-colors motion-safe:active:scale-[0.97] [-webkit-tap-highlight-color:transparent]",
              on ? "text-ink" : "text-dim",
            )}
          >
            {t.icon}
            {t.label}
            <span
              aria-hidden
              className={cx(
                "absolute inset-x-3 bottom-1 h-0.5 rounded-full bg-accent transition-[opacity,transform] duration-200 motion-reduce:transition-none",
                on ? "scale-x-100 opacity-100" : "scale-x-50 opacity-0",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
