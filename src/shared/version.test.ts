import { describe, expect, it } from "vitest";
import { compareVersions, isNewer } from "./version";

describe("version order, pre-releases included", () => {
  it("orders an rc's next rc after it, and the release after both", () => {
    expect(isNewer("0.16.0-rc.8", "0.16.0-rc.7")).toBe(true);
    expect(isNewer("0.16.0-rc.10", "0.16.0-rc.9")).toBe(true);
    expect(isNewer("0.16.0", "0.16.0-rc.8")).toBe(true);
    expect(isNewer("1.0.0", "0.16.0-rc.8")).toBe(true);
    expect(isNewer("v0.16.0-rc.8", "0.16.0-rc.8")).toBe(false);
  });

  it("never offers an older version or the same one", () => {
    expect(isNewer("0.16.0-rc.7", "0.16.0-rc.8")).toBe(false);
    expect(isNewer("0.16.0-rc.8", "0.16.0")).toBe(false);
    expect(isNewer("0.15.0", "0.16.0-rc.8")).toBe(false);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
  });

  it("follows semver's identifiers, and says nothing of what isn't a version", () => {
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBeLessThan(0);
    expect(compareVersions("1.0.0-beta", "1.0.0-rc.1")).toBeLessThan(0);
    expect(compareVersions("1.0.0+build.5", "1.0.0")).toBe(0);
    expect(compareVersions("latest", "1.0.0")).toBeNull();
    expect(isNewer("latest", "1.0.0")).toBe(false);
  });
});
