import { describe, expect, it } from "vitest";
import { Lru } from "./lru";

describe("Lru", () => {
  it("forgets the least recently used past its cap", () => {
    const c = new Lru<string, number>(2);
    c.set("a", 1).set("b", 2);
    c.get("a"); // a is used: b is now the oldest
    c.set("c", 3);
    expect(c.has("b")).toBe(false);
    expect(c.get("a")).toBe(1);
    expect(c.get("c")).toBe(3);
    expect(c.size).toBe(2);
  });

  it("keeps a stored undefined or null apart from a miss, and a re-set refreshes", () => {
    const c = new Lru<string, string | null>(2);
    c.set("miss", null);
    expect(c.has("miss")).toBe(true);
    expect(c.get("miss")).toBeNull();
    expect(c.get("never")).toBeUndefined();
    c.set("x", "1").set("miss", null).set("y", "2");
    expect(c.has("x")).toBe(false);
    expect(c.has("miss")).toBe(true);
  });
});
