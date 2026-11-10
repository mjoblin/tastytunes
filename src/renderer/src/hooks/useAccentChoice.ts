import { useEffect } from "react";
import type { AccentChoice } from "@shared/model";

/**
 * The accent's color (Settings › Appearance › Accent color): a class on :root picks sage or the
 * dusty teal (styles.css names each color once per theme); sand is the default and wears no class,
 * and From album art leaves the default showing until useArtAccent tints over it.
 */
export function useAccentChoice(choice: AccentChoice): void {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("accent-sage", choice === "sage");
    root.classList.toggle("accent-teal", choice === "teal");
  }, [choice]);
}
