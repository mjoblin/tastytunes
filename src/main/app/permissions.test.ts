import { describe, expect, it } from "vitest";

import { permitted } from "./permissions";

describe("permitted: a page gets only what the app uses", () => {
  it("allows the copy buttons' clipboard writes and display mode's fullscreen", () => {
    expect(permitted("clipboard-sanitized-write")).toBe(true);
    expect(permitted("fullscreen")).toBe(true);
  });

  it("denies everything else", () => {
    for (const p of [
      "media",
      "geolocation",
      "notifications",
      "midi",
      "clipboard-read",
      "openExternal",
    ])
      expect(permitted(p)).toBe(false);
  });
});
