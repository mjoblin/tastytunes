import { afterEach, describe, expect, it, vi } from "vitest";
import { menuAt } from "./menuAt";

// the unit tests run without a DOM: an Element that has only its box
class Box {
  getBoundingClientRect(): { left: number; bottom: number } {
    return { left: 300, bottom: 120 };
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("where a menu opens", () => {
  it("is the pointer for a click or a right-click", () => {
    vi.stubGlobal("Element", Box);
    const at = { clientX: 40, clientY: 50, currentTarget: new Box() as unknown as EventTarget };
    expect(menuAt({ ...at, type: "click", detail: 1 })).toEqual({ x: 40, y: 50 });
    expect(menuAt({ ...at, type: "contextmenu", detail: 0 })).toEqual({ x: 40, y: 50 });
  });

  it("is under the control for a key press, which has no pointer", () => {
    vi.stubGlobal("Element", Box);
    const control = new Box() as unknown as EventTarget;
    expect(
      menuAt({ type: "click", detail: 0, clientX: 0, clientY: 0, currentTarget: control }),
    ).toEqual({
      x: 300,
      y: 124,
    });
    // the context-menu key: no pointer either
    expect(menuAt({ type: "contextmenu", clientX: 0, clientY: 0, currentTarget: control })).toEqual(
      {
        x: 300,
        y: 124,
      },
    );
  });

  it("falls back to the pointer with no control to place it under", () => {
    vi.stubGlobal("Element", Box);
    expect(
      menuAt({ type: "click", detail: 0, clientX: 0, clientY: 0, currentTarget: null }),
    ).toEqual({
      x: 0,
      y: 0,
    });
  });
});
