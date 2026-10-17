import { describe, expect, it } from "vitest";
import { hasLocalNetworkPrivacy } from "./localNetwork";

describe("local network privacy", () => {
  it("is asked about on macOS 15 and later", () => {
    expect(hasLocalNetworkPrivacy("darwin", "15.0.0")).toBe(true);
    expect(hasLocalNetworkPrivacy("darwin", "15.7.1")).toBe(true);
    expect(hasLocalNetworkPrivacy("darwin", "26.0.1")).toBe(true);
  });
  it("is not asked about before macOS 15, nor off the Mac", () => {
    expect(hasLocalNetworkPrivacy("darwin", "14.7.6")).toBe(false);
    expect(hasLocalNetworkPrivacy("darwin", "12.0")).toBe(false);
    expect(hasLocalNetworkPrivacy("darwin", "")).toBe(false);
    expect(hasLocalNetworkPrivacy("win32", "10.0.26100")).toBe(false);
    expect(hasLocalNetworkPrivacy("linux", "6.8.0")).toBe(false);
  });
});
