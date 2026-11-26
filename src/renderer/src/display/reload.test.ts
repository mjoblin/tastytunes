import { describe, expect, it } from "vitest";
import { forgetReloads, reloadWait } from "./reload";

/** A tab's sessionStorage. */
const tab = (): Pick<Storage, "getItem" | "setItem" | "removeItem"> => {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
};

describe("a page that fails loads again", () => {
  it("waits longer each time it keeps failing, then holds at the longest", () => {
    const s = tab();
    const waits = [1, 2, 3, 4, 5, 6].map(() => reloadWait(s));
    expect(waits).toEqual([3_000, 10_000, 30_000, 60_000, 60_000, 60_000]);
  });

  it("waits the shortest again once the page has run cleanly", () => {
    const s = tab();
    reloadWait(s);
    reloadWait(s);
    forgetReloads(s);
    expect(reloadWait(s)).toBe(3_000);
  });

  it("waits the shortest where the tab keeps nothing, or kept nonsense", () => {
    expect(reloadWait(null)).toBe(3_000);
    const s = tab();
    s.setItem("tt-display-reloads", "nonsense");
    expect(reloadWait(s)).toBe(3_000);
    const refusing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(reloadWait(refusing)).toBe(3_000);
  });
});
