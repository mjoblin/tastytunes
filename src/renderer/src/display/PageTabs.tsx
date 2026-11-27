import { useLayoutEffect, useRef, useState } from "react";
import { cx } from "@/lib/format";

/**
 * THE PAGE'S TABS (0.17.0, Display on other screens): one home for the two tab strips on the page,
 * the corner panel's Scene and Settings (display/ScenePanel) and the list's Queue, Presets and
 * Playlists (display/PageTransport). Words at their own width, the chosen one in ink on a soft
 * capsule that glides to the tab tapped (straight there under reduced motion), the others dim: a
 * tab picks what the panel shows, and the gold-filled segmented look stays the app's for a toggle
 * that sets a value (controls/Segmented). A finger's height, 44px.
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
  const strip = useRef<HTMLDivElement | null>(null);
  /** The capsule's place under the chosen tab; null until measured, so it never slides in from
   *  the strip's start as the panel opens. */
  const [at, setAt] = useState<{ left: number; width: number } | null>(null);
  const [glides, setGlides] = useState(false);
  useLayoutEffect(() => {
    const el = strip.current;
    if (!el) return;
    const measure = (): void => {
      const tab = el.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (tab) setAt({ left: tab.offsetLeft, width: tab.offsetWidth });
    };
    measure();
    // the words' own widths settle as the font arrives
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    return () => seen.disconnect();
  }, [value, tabs.length]);
  return (
    <div ref={strip} role="tablist" className="relative flex min-w-0 items-center gap-1">
      {at && (
        <span
          aria-hidden
          data-page-tab-capsule
          className={cx(
            "pointer-events-none absolute inset-y-1 left-0 rounded-full bg-veil2 shadow-sm ring-1 ring-edge",
            glides &&
              "transition-[transform,width] duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none",
          )}
          style={{ width: at.width, transform: `translateX(${at.left}px)` }}
        />
      )}
      {tabs.map((t) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            {...t.attrs}
            aria-selected={on}
            onClick={() => {
              setGlides(true);
              onChange(t.id);
            }}
            className={cx(
              "relative flex h-11 shrink-0 items-center gap-2 px-4 text-[15px] font-medium transition-colors duration-200 motion-safe:active:scale-[0.97] [-webkit-tap-highlight-color:transparent]",
              on ? "text-ink" : "text-dim",
            )}
          >
            {t.icon}
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

/** A page panel's scrolling body, under its tabs (the lists' and the scene panel's alike): 8px at
 *  the sides, and at each end its edge's ramp (styles.css fade-edges, the app's pages' own), so a
 *  row passing under the tabs or the panel's foot dissolves rather than being cut through its
 *  words; at rest the first row and, at full scroll, the last sit clear of it. */
export const PANEL_EDGE_PX = 12;
export const PANEL_BODY =
  "fade-edges min-h-0 overflow-y-auto overscroll-contain px-2 py-3 [--fade-top-solid:12px] [--fade-bottom:12px]";
