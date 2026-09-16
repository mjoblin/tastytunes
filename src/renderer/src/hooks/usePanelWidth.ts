import { DEFAULT_SETTINGS } from "@shared/model";
import { useStore } from "@/store";
import { useDragExtent } from "./useDragExtent";

/** The persisted default IS the detent — a fresh install opens snapped. */
export const PANEL_DEFAULT_WIDTH = DEFAULT_SETTINGS.panelWidth;
const MIN_WIDTH = 250;
const MAX_WIDTH = 800;

/**
 * Shared drag-to-resize width for the Now Playing drawers (lyrics/artist):
 * useDragExtent on settings.panelWidth. Right-anchored, so dragging left
 * grows it.
 */
export function usePanelWidth(): {
  width: number;
  dragging: boolean;
  /** Sitting on the default-width detent. */
  snapped: boolean;
  handleProps: ReturnType<typeof useDragExtent>["handleProps"];
} {
  const saved = useStore((s) => s.settings.panelWidth);
  const saveSettings = useStore((s) => s.saveSettings);
  const { size, dragging, snapped, handleProps } = useDragExtent({
    saved,
    save: (panelWidth) => saveSettings({ panelWidth }),
    detent: PANEL_DEFAULT_WIDTH,
    min: MIN_WIDTH,
    // Clamp to the viewport-relative cap too, so the logical width never
    // exceeds what the CSS max renders — otherwise the drag has dead travel.
    max: () => Math.min(MAX_WIDTH, Math.floor(window.innerWidth * 0.6)),
    axis: "x",
    grow: -1,
  });
  return { width: size, dragging, snapped, handleProps };
}
