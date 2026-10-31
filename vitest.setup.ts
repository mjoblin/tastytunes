// Every test file runs with this ELECTRON STUB (0.13.0, the hygiene item "unit tests of main
// modules mock electron by hand"): CI installs no Electron binary, so a module that imports
// electron throws there while passing on a Mac that has one (crashReload.test.ts failed every
// branch's CI after the reload fix imported app). The stub is what a main module touches at
// import time and in a test: the app's paths (a fresh temp folder per test file, never the
// user's data), its version, its event hooks, and empty web contents, images and sessions. A
// test that needs more mocks it in its own file, which replaces this one.
import { vi } from "vitest";

vi.mock("electron", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const userData = mkdtempSync(join(tmpdir(), "tt-vitest-"));
  const app = {
    getPath: () => userData,
    getVersion: () => "0.0.0",
    isPackaged: false,
    on: () => app,
    once: () => app,
  };
  const webContents = { getAllWebContents: () => [] };
  const nativeImage = {};
  const session = {};
  return {
    default: { app, webContents, nativeImage, session },
    app,
    webContents,
    nativeImage,
    session,
  };
});
