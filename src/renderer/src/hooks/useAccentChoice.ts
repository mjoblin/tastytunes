import { useEffect } from "react";
import type { AccentChoice } from "@shared/model";

/** The choices drawn by a class on :root (styles.css names each color once per theme). */
const CLASSED = ["gold", "sage", "teal"] as const satisfies readonly AccentChoice[];

/**
 * The accent's color (Settings › Appearance › Accent color): a class on :root picks gold, sage or
 * the dusty teal; sand is the default and wears no class, and From album art leaves the default
 * showing until useArtAccent tints over it.
 */
export function useAccentChoice(choice: AccentChoice): void {
  useEffect(() => {
    const root = document.documentElement;
    for (const id of CLASSED) root.classList.toggle(`accent-choice-${id}`, choice === id);
  }, [choice]);
}
