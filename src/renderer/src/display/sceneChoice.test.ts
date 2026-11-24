import { afterEach, describe, expect, it, vi } from "vitest";
import { ownScene, sceneHere, setOwnScene } from "./sceneChoice";

const store = (): Map<string, string> => {
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  });
  return m;
};

afterEach(() => vi.unstubAllGlobals());

describe("a scene for this screen", () => {
  it("shows the app's scene until one is picked here, and again once it is let go", () => {
    store();
    expect(sceneHere("tide")).toBe("tide");
    setOwnScene("type");
    expect(ownScene()).toBe("type");
    expect(sceneHere("tide")).toBe("type");
    setOwnScene(null);
    expect(sceneHere("tide")).toBe("tide");
  });

  it("ignores a stored name that is no scene", () => {
    store().set("tastytunes.displayScene", "nonsense");
    expect(sceneHere("orbit")).toBe("orbit");
  });

  it("keeps the choice for the page's life when the browser keeps nothing", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });
    setOwnScene("refrain");
    expect(sceneHere("tide")).toBe("refrain");
    setOwnScene(null);
    expect(sceneHere("tide")).toBe("tide");
  });
});
