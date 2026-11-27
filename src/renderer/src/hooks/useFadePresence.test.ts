import { describe, expect, it } from "vitest";
import { fadeClasses } from "./useFadePresence";

const has = (classes: string, ...want: string[]): boolean =>
  want.every((c) => classes.split(/\s+/).includes(c));

describe("a fade's classes", () => {
  it("are the window's 140ms opacity fade by default, the same opening and closing", () => {
    expect(has(fadeClasses(true, true, false), "opacity-100", "motion-safe:duration-[140ms]")).toBe(
      true,
    );
    expect(has(fadeClasses(false, false, false), "opacity-0", "motion-safe:duration-[140ms]")).toBe(
      true,
    );
    expect(fadeClasses(true, false, false)).not.toMatch(/translate/);
  });

  it("with rise, open from 8px below, settle in 200ms, and close in 150ms 4px down", () => {
    expect(has(fadeClasses(true, false, true), "opacity-0", "translate-y-2")).toBe(true);
    const shown = fadeClasses(true, true, true);
    expect(has(shown, "opacity-100", "translate-y-0", "motion-safe:duration-200")).toBe(true);
    const leaving = fadeClasses(false, true, true);
    expect(has(leaving, "opacity-0", "translate-y-1", "motion-safe:duration-150")).toBe(true);
  });

  it("move only opacity and translate, and only where motion is welcome", () => {
    for (const c of [fadeClasses(true, true, true), fadeClasses(false, false, true)]) {
      expect(c).toMatch(/motion-safe:transition-\[opacity,translate\]/);
      expect(c).not.toMatch(/(^|\s)transition-/);
    }
  });

  it("let a closing panel take no touches, so a tap during the fade-out reaches the page", () => {
    expect(has(fadeClasses(false, true, true), "pointer-events-none")).toBe(true);
    expect(fadeClasses(true, true, true)).not.toMatch(/pointer-events-none/);
  });
});
