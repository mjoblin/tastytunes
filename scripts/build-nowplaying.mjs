// Builds the Now Playing helper (native/nowplaying/main.swift) as one universal binary, arm64 and
// x86_64 for macOS 13 and later, at build/nowplaying/TastyTunes Now Playing, where
// electron-builder's mac extraFiles takes it into the app's Contents/Helpers. macOS only: on any
// other system it says so and does nothing, since only the Mac build ships it. The Swift 5
// language mode is pinned (see the source's header).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NAME = "TastyTunes Now Playing";
if (process.platform !== "darwin") {
  console.log("build-nowplaying: not macOS, nothing to build");
  process.exit(0);
}
const root = join(import.meta.dirname, "..");
const source = join(root, "native", "nowplaying", "main.swift");
const outDir = join(root, "build", "nowplaying");
const work = mkdtempSync(join(tmpdir(), "tt-nowplaying-"));
try {
  const slices = ["arm64", "x86_64"].map((arch) => {
    const out = join(work, arch);
    execFileSync(
      "xcrun",
      ["swiftc", "-swift-version", "5", "-O", "-target", `${arch}-apple-macos13.0`, "-o", out, source],
      { stdio: "inherit" },
    );
    return out;
  });
  mkdirSync(outDir, { recursive: true });
  execFileSync("lipo", ["-create", ...slices, "-output", join(outDir, NAME)], { stdio: "inherit" });
  console.log(`build-nowplaying: ${join("build", "nowplaying", NAME)} (arm64, x86_64)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
