import { describe, expect, it, vi } from "vitest";
import { keptLookup, Lru } from "./lru";

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

describe("keptLookup", () => {
  it("asks once, sharing the ask while it is out and its answer after", async () => {
    const c = new Lru<string, Promise<string | null>>(4);
    const look = vi.fn(() => Promise.resolve("cover"));
    const first = keptLookup(c, "a", look);
    expect(keptLookup(c, "a", look)).toBe(first);
    expect(await first).toBe("cover");
    expect(await keptLookup(c, "a", look)).toBe("cover");
    expect(look).toHaveBeenCalledTimes(1);
  });

  it("lets a miss go as it settles, so the next ask tries again", async () => {
    const c = new Lru<string, Promise<string | null>>(4);
    const look = vi.fn<() => Promise<string | null>>();
    look.mockResolvedValueOnce(null).mockResolvedValueOnce("cover");
    expect(await keptLookup(c, "a", look)).toBeNull();
    expect(c.has("a")).toBe(false);
    expect(await keptLookup(c, "a", look)).toBe("cover");
    expect(await keptLookup(c, "a", look)).toBe("cover");
    expect(look).toHaveBeenCalledTimes(2);
  });

  it("answers a throw as a miss, and lets it go too", async () => {
    const c = new Lru<string, Promise<string | null>>(4);
    const look = vi.fn<() => Promise<string | null>>();
    look.mockRejectedValueOnce(new Error("unreachable")).mockResolvedValueOnce("cover");
    expect(await keptLookup(c, "a", look)).toBeNull();
    expect(await keptLookup(c, "a", look)).toBe("cover");
  });

  it("leaves a newer ask for the key kept when an older one misses", async () => {
    const c = new Lru<string, Promise<string | null>>(1);
    let miss: (v: string | null) => void = () => {};
    const old = keptLookup(c, "a", () => new Promise((r) => (miss = r)));
    // "a" falls out of the cache while its ask is out, and is asked anew
    void keptLookup(c, "b", () => Promise.resolve("other"));
    const fresh = keptLookup(c, "a", () => Promise.resolve("cover"));
    miss(null);
    expect(await old).toBeNull();
    expect(c.peek("a")).toBe(fresh);
    expect(await keptLookup(c, "a", () => Promise.resolve("never"))).toBe("cover");
  });

  it("peeks without counting a use", () => {
    const c = new Lru<string, number>(2);
    c.set("a", 1).set("b", 2);
    expect(c.peek("a")).toBe(1);
    c.set("c", 3);
    expect(c.has("a")).toBe(false);
  });
});
