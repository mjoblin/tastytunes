import { useEffect } from "react";
import type { DisplayFont } from "@shared/model";

/**
 * The curated display faces. Every face ships in the bundle (fontsource
 * variable packages, imported in main.tsx) — the browser only downloads the
 * woff2 for families actually used, so the inactive faces cost nothing at
 * runtime. Stacks fall back to the same generics styles.css declares.
 *
 * `scale` is an optical-size correction: at the same px, faces don't read the
 * same visual size (Unbounded's heavy x-height looks large; Instrument Serif's
 * high-contrast forms look small). The scale multiplies every font-display
 * element via `zoom: var(--font-display-scale)` so the difference the eye sees
 * is the face's character, not its size. Tuned by eye against Fraunces (1.0).
 */
export const DISPLAY_FONTS: Array<{
  id: DisplayFont;
  label: string;
  stack: string;
  scale: number;
}> = [
  { id: "fraunces", label: "Fraunces", stack: "'Fraunces Variable', Georgia, serif", scale: 1.0 },
  {
    id: "unbounded",
    label: "Unbounded",
    stack: "'Unbounded Variable', ui-sans-serif, sans-serif",
    scale: 0.82,
  },
  {
    id: "newsreader",
    label: "Newsreader",
    stack: "'Newsreader Variable', Georgia, serif",
    scale: 1.0,
  },
  {
    id: "hanken",
    label: "Hanken Grotesk",
    stack: "'Hanken Grotesk Variable', ui-sans-serif, sans-serif",
    scale: 0.95,
  },
  {
    id: "instrument-serif",
    label: "Instrument Serif",
    stack: "'Instrument Serif', Georgia, serif",
    scale: 1.08,
  },
  {
    id: "schibsted",
    label: "Schibsted Grotesk",
    stack: "'Schibsted Grotesk Variable', ui-sans-serif, sans-serif",
    scale: 0.97,
  },
  {
    id: "instrument-sans",
    label: "Instrument Sans",
    stack: "'Instrument Sans Variable', ui-sans-serif, system-ui, sans-serif",
    scale: 0.96,
  },
];

const face = (id: DisplayFont): (typeof DISPLAY_FONTS)[number] =>
  DISPLAY_FONTS.find((f) => f.id === id) ?? DISPLAY_FONTS[0];

export const fontStack = (id: DisplayFont): string => face(id).stack;
export const fontScale = (id: DisplayFont): number => face(id).scale;

/**
 * Apply the chosen display face by overriding the --font-display token (family)
 * and --font-display-scale (optical correction) on the root — every
 * font-display utility in the app follows. Mounted by both windows (App and
 * MiniPlayer), like useTheme.
 */
export function useDisplayFont(pref: DisplayFont): void {
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--font-display", fontStack(pref));
    root.setProperty("--font-display-scale", String(fontScale(pref)));
  }, [pref]);
}
