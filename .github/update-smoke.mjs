// Update smoke: the previous published build (installed, or the AppImage fetched, by the workflow)
// updated to the newest through its own Check, Download and Restart against the REAL feed, then
// launched again and its version asserted. The harness can't prove this: its feed override has no
// publisher, so the signature check is skipped, and nothing there installs or relaunches.
//
//   TT_EXE=<installed exe or AppImage> TT_EXPECT=<newest version> node .github/update-smoke.mjs
//
// With TT_EXPECT_NONE=1 (the workflow sets it when a stable build meets a newer pre-release, as a
// version's first rc does) the run asserts the other half: the stable build's check answers none,
// since a stable build is never offered a pre-release, and nothing is downloaded or installed.
import { _electron } from "playwright-core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const exe = process.env.TT_EXE;
const expect = process.env.TT_EXPECT;
const expectNone = process.env.TT_EXPECT_NONE === "1";
if (!exe || !existsSync(exe) || !expect) {
  console.error(`TT_EXE (${exe}) and TT_EXPECT (${expect}) are both needed`);
  process.exit(1);
}

const win = process.platform === "win32";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failed++;
  return cond;
};

// a sandboxed profile, and every service but the update feed sunk: the feed is the point
const ud = mkdtempSync(join(tmpdir(), "tt-update-"));
const sink = "http://127.0.0.1:9/";
const env = {
  ...process.env,
  TASTYTUNES_USER_DATA: ud,
  TASTYTUNES_SSDP_TARGET: "127.0.0.1:1",
  TASTYTUNES_LYRICS_URL: sink,
  TASTYTUNES_RADIO_URL: sink,
  TASTYTUNES_ARTIST_URL: sink,
  TASTYTUNES_MB_URL: sink,
};
// the AppImage on a CI runner runs without the setuid sandbox, as linux-smoke.yml launches it
const args = process.platform === "linux" ? ["--no-sandbox"] : [];
const launch = () => _electron.launch({ executablePath: exe, env, args });
const versionOf = (app) => app.evaluate(({ app }) => app.getVersion());

/** Whether an instance of the app is running (the one the installer or the AppImage relaunched). */
function running() {
  try {
    const out = win
      ? execFileSync("tasklist", ["/FI", "IMAGENAME eq TastyTunes.exe", "/NH"]).toString()
      : execFileSync("pgrep", ["-f", "TastyTunes"]).toString();
    return win ? /TastyTunes\.exe/i.test(out) : out.trim() !== "";
  } catch {
    return false;
  }
}
function stopAll() {
  try {
    if (win) execFileSync("taskkill", ["/IM", "TastyTunes.exe", "/F"]);
    else execFileSync("pkill", ["-f", "TastyTunes"]);
  } catch {
    // none left
  }
}

let app = await launch();
if (expectNone) {
  try {
    const page = await app.firstWindow({ timeout: 60000 });
    const from = await versionOf(app);
    ok(
      `the stable build runs (${from}, the feed's newest the pre-release ${expect})`,
      !from.includes("-"),
    );
    const found = await page.evaluate(() => window.tastytunes.updateCheckNow());
    ok(
      `a stable build is offered no pre-release: the check answers none (${JSON.stringify(found)})`,
      found?.status === "none",
    );
  } catch (e) {
    ok("the check ran", false, e instanceof Error ? e.message : String(e));
  } finally {
    await app.close().catch(() => {});
    stopAll();
  }
  console.log(
    failed === 0 ? "\nupdate smoke: all checks passed" : `\nupdate smoke: ${failed} failed`,
  );
  process.exit(failed === 0 ? 0 : 1);
}
try {
  const page = await app.firstWindow({ timeout: 60000 });
  const from = await versionOf(app);
  ok(`the previous build runs (${from}, the feed's newest ${expect})`, from !== expect);
  const found = await page.evaluate(() => window.tastytunes.updateCheckNow());
  // a build from before 0.16.0-rc.8 ordered versions without their pre-release part, so its Check
  // now says there is nothing newer between two rcs while its window is still offered the update
  // (the download and the restart below prove it); a later build must find it
  const oldCheck = found?.status === "none" && /^0\.16\.0-rc\.[1-7]$/.test(from);
  ok(
    `the check finds ${expect} on the real feed (${JSON.stringify(found)}${oldCheck ? `; ${from} predates the pre-release check` : ""})`,
    (found?.status === "update" && found.version === expect) || oldCheck,
  );
  // resolves once the download is done, or has failed (the window then shows why)
  await page.evaluate(() => window.tastytunes.updateDownload());
  const exited = new Promise((r) => app.process().once("exit", () => r(true)));
  await page.evaluate(() => window.tastytunes.updateInstall()).catch(() => {});
  ok(
    "Restart now quits the app to install the update",
    await Promise.race([exited, sleep(60_000).then(() => false)]),
  );
} catch (e) {
  ok("the update ran", false, e instanceof Error ? e.message : String(e));
}

// the installer (Windows) or the replaced AppImage relaunches the app: wait for it, then stop it
let relaunched = false;
for (let i = 0; i < 48 && !relaunched; i++) {
  await sleep(5000);
  relaunched = running();
}
ok("the updated app relaunches on its own", relaunched);
await sleep(5000);
stopAll();
await sleep(3000);

try {
  app = await launch();
  await app.firstWindow({ timeout: 60000 });
  const now = await versionOf(app);
  ok(`it comes back up as ${expect} (${now})`, now === expect);
} catch (e) {
  ok("the updated app launches", false, e instanceof Error ? e.message : String(e));
} finally {
  await app.close().catch(() => {});
  stopAll();
}

console.log(
  failed === 0 ? "\nupdate smoke: all checks passed" : `\nupdate smoke: ${failed} failed`,
);
process.exit(failed === 0 ? 0 : 1);
