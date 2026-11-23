import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HELPER_NAME, helperPath, type HelperPlace } from "./nowPlayingHelper";

const place = (over: Partial<HelperPlace>): HelperPlace => ({
  packaged: true,
  platform: "darwin",
  env: {},
  resourcesPath: "/Applications/TastyTunes.app/Contents/Resources",
  execPath: "C:\\Program Files\\TastyTunes\\TastyTunes.exe",
  exists: () => true,
  ...over,
});

describe("which Now Playing helper runs", () => {
  it("is the app's own when packaged: Contents/Helpers on macOS, beside the exe on Windows", () => {
    expect(helperPath(place({}))).toBe(
      join("/Applications/TastyTunes.app/Contents/Resources", "..", "Helpers", HELPER_NAME),
    );
    expect(helperPath(place({ platform: "win32", execPath: "/opt/tt/TastyTunes.exe" }))).toBe(
      join("/opt/tt", `${HELPER_NAME}.exe`),
    );
    expect(helperPath(place({ platform: "linux" }))).toBeNull();
    expect(helperPath(place({ exists: () => false }))).toBeNull();
  });

  it("never reads the development override in a packaged app", () => {
    const env = { TASTYTUNES_NP_HELPER: "/tmp/anything" };
    expect(helperPath(place({ env }))).not.toBe("/tmp/anything");
    expect(helperPath(place({ env, exists: () => false }))).toBeNull();
  });

  it("runs in development only the helper the override names", () => {
    expect(helperPath(place({ packaged: false }))).toBeNull();
    expect(
      helperPath(place({ packaged: false, env: { TASTYTUNES_NP_HELPER: "/tmp/fake.mjs" } })),
    ).toBe("/tmp/fake.mjs");
  });
});
