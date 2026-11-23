// Builds the Windows Now Playing helper (native/nowplaying-win/main.cpp) with MSVC, one exe per
// architecture, x64 and arm64, at build/nowplaying-win/<arch>/TastyTunes Now Playing.exe, where
// electron-builder's win extraFiles takes the installer's architecture's copy beside
// TastyTunes.exe. Windows only: elsewhere it says so and does nothing, since only the Windows
// build ships it. C++/WinRT from the Windows SDK, no runtime to install and no dependency.
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const NAME = "TastyTunes Now Playing.exe";
if (process.platform !== "win32") {
  console.log("build-nowplaying-win: not Windows, nothing to build");
  process.exit(0);
}
const root = join(import.meta.dirname, "..");
const vswhere = join(
  process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
  "Microsoft Visual Studio",
  "Installer",
  "vswhere.exe",
);
const vs = execFileSync(vswhere, ["-latest", "-products", "*", "-property", "installationPath"], {
  encoding: "utf8",
}).trim();
const vcvars = join(vs, "VC", "Auxiliary", "Build", "vcvarsall.bat");
const host = process.arch === "arm64" ? "arm64" : "x64";
const source = join(root, "native", "nowplaying-win", "main.cpp");
for (const arch of ["x64", "arm64"]) {
  const outDir = join(root, "build", "nowplaying-win", arch);
  mkdirSync(outDir, { recursive: true });
  const target = host === arch ? arch : `${host}_${arch}`;
  const cl = [
    "cl /nologo /std:c++17 /EHsc /O2 /permissive- /DUNICODE /D_UNICODE",
    `"${source}"`,
    `/Fo"${outDir}\\\\"`,
    `/Fe"${join(outDir, NAME)}"`,
    "/link windowsapp.lib ole32.lib shell32.lib",
  ].join(" ");
  execSync(`call "${vcvars}" ${target} >nul && ${cl}`, { stdio: "inherit", shell: "cmd.exe" });
  console.log(`build-nowplaying-win: ${join("build", "nowplaying-win", arch, NAME)}`);
}
