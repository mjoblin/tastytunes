import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "@/store";
import { useDragExtent } from "./useDragExtent";

/** The default and the smallest: the size both headers drew before (and the detent). */
export const HEADER_ART_PX = 160;
/** The largest whatever the room: Now Playing's top tier. */
const MAX_PX = 400;
/** The share of the header's row the picture may take, so the words beside it keep the rest. */
const ROW_SHARE = 0.3;

/**
 * The picture's size in the Library's album and artist headers (0.11.0, his ask after the
 * artist page: "what if we allowed them to resize the art on the artist and album screen
 * too"). The Now Playing grip's gesture (useDragExtent: live while dragging, saved on release,
 * a detent at the default, one undo entry), one size for both headers (settings'
 * libraryHeaderArt), clamped to the row's cap at draw time. The row is measured when it is
 * attached, before the first paint, so a page never opens at the default and then jumps.
 */
export function useHeaderArtSize(undoLabel: string): {
  size: number;
  /** The size as saved, which a drag does not move until it is released. */
  settled: number;
  dragging: boolean;
  snapped: boolean;
  handleProps: ReturnType<typeof useDragExtent>["handleProps"];
  attachRow(node: HTMLElement | null): void;
} {
  const stored = useStore((s) => s.settings.libraryHeaderArt);
  const saveSettings = useStore((s) => s.saveSettings);
  const [row, setRow] = useState(0);
  const obs = useRef<ResizeObserver | null>(null);
  const attachRow = useCallback((node: HTMLElement | null): void => {
    obs.current?.disconnect();
    obs.current = null;
    if (!node) return;
    setRow(node.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setRow(e.contentRect.width);
    });
    ro.observe(node);
    obs.current = ro;
  }, []);
  useEffect(() => () => obs.current?.disconnect(), []);
  const cap = Math.max(HEADER_ART_PX, Math.min(MAX_PX, Math.round(row * ROW_SHARE)));
  // the file is merged over the defaults unchecked: anything but a number is the default
  const wanted = typeof stored === "number" && Number.isFinite(stored) ? stored : HEADER_ART_PX;
  const saved = Math.max(HEADER_ART_PX, Math.min(cap, Math.round(wanted)));
  const { size, dragging, snapped, handleProps } = useDragExtent({
    saved,
    save: (px) => saveSettings({ libraryHeaderArt: px === HEADER_ART_PX ? null : px }),
    detent: HEADER_ART_PX,
    min: HEADER_ART_PX,
    max: () => cap,
    axis: "x",
    grow: 1,
    undoLabel,
  });
  return { size, settled: saved, dragging, snapped, handleProps, attachRow };
}
