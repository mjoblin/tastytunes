// Self-update with a Sparkle-style consent flow. electron-updater does the
// mechanics (feed check, download, signature-verified install); this module
// owns the states and makes sure NOTHING moves without the user's say-so:
// autoDownload is off (consent #1 = the Download button) and install happens
// on quit or via the explicit Restart button (consent #2).
//
// Unpackaged builds can't self-update — there the legacy stage-1 checker
// (updateCheck.ts) still finds releases and the UI offers the release page
// instead. TASTYTUNES_UPDATE_FEED forces the real updater against a local
// generic feed so harnesses can drive the whole consent flow.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { app } from "electron";
import electronUpdater from "electron-updater";
import { version as appVersion } from "../../../package.json";
import { REPO_URL } from "@shared/ipc";
import { noteRequest } from "../netlog";
import { type UpdateCheckResult, type UpdateState } from "@shared/model";
import { getSettings } from "../data/persist";
import {
  checkNow as legacyCheckNow,
  checkOnDemand as legacyCheckOnDemand,
  isNewer,
  startUpdateCheck as startLegacyCheck,
} from "./updateCheck";
import { devOverride } from "./devOverride";

const { autoUpdater } = electronUpdater;

const RELEASES_PAGE = `${REPO_URL}/releases/latest`;
const FEED = devOverride("TASTYTUNES_UPDATE_FEED");
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

let state: UpdateState = {
  phase: "idle",
  version: null,
  percent: null,
  canDownload: false,
  url: RELEASES_PAGE,
  error: null,
};
let announce: (s: UpdateState) => void = () => {};

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };
  if (FEED) console.log("[updateState]", JSON.stringify(state));
  announce(state);
}

/** For windows created/reloaded after the last push. */
export function currentUpdateState(): UpdateState {
  return state;
}

// A packaged Linux build updates itself only as an AppImage (APPIMAGE names the file to replace);
// run any other way it was told it was on the latest release (0.16.0), and is offered the release
// page instead, as a development build is
const updaterUsable = (): boolean =>
  (app.isPackaged && !(process.platform === "linux" && !process.env["APPIMAGE"])) || !!FEED;
let installing = false;

export function startUpdater(onState: (s: UpdateState) => void): void {
  announce = onState;

  if (!updaterUsable()) {
    // Dev build: stage-1 awareness only — the About row offers the release page.
    startLegacyCheck((info) => {
      setState({ phase: "available", version: info.version, url: info.url, canDownload: false });
    });
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  // Pre-releases (2026-08-17): a stable build never sees a GitHub pre-release;
  // a build whose OWN version carries a pre-release suffix (0.3.0-rc.1, cut
  // from a release branch by dev/tag-release.sh) is offered the next rc AND
  // the final stable that supersedes it, so a tester rejoins the normal train
  // on their own. The second half is NOT electron-updater's default for an
  // "rc" (see checkForUpdates); never for store builds (they have no updater).
  autoUpdater.allowPrerelease = PRERELEASE;
  if (FEED) {
    // The download path re-reads the dev update config from disk (setFeedURL
    // alone ENOENTs there) — write a real config file and point at it.
    autoUpdater.forceDevUpdateConfig = true;
    const cfgPath = join(app.getPath("temp"), `tt-dev-app-update-${process.pid}.yml`);
    writeFileSync(cfgPath, `provider: generic\nurl: ${FEED}\n`);
    autoUpdater.updateConfigPath = cfgPath;
    autoUpdater.logger = console; // harness-only verbosity
    // Unpackaged (harness) launches report Electron's own version through
    // app.getVersion() — pin the app's real version or nothing is ever newer.
    // currentVersion is a plain runtime field despite the readonly typing, and
    // it must be a SemVer from electron-updater's own NESTED semver copy — a
    // hoisted-semver instance fails its instanceof coercion.
    try {
      const req = createRequire(import.meta.url);
      const updaterSemver = createRequire(req.resolve("electron-updater"))("semver") as {
        parse(v: string): unknown;
      };
      const v = updaterSemver.parse(appVersion);
      if (v) (autoUpdater as unknown as { currentVersion: unknown }).currentVersion = v;
    } catch {
      // harness-only nicety; never worth failing startup over
    }
  }

  autoUpdater.on("update-available", (info) => {
    // the 4-hourly check finding the same version again leaves a download under way, or done, as
    // it is (0.16.0 turned Restart now back into Download; the update still installed on quit)
    if (
      (state.phase === "downloading" || state.phase === "downloaded") &&
      state.version === info.version
    )
      return;
    setState({ phase: "available", version: info.version, canDownload: true, error: null });
  });
  autoUpdater.on("update-not-available", () => {
    if (state.phase === "available") setState({ phase: "idle", version: null });
  });
  autoUpdater.on("download-progress", (p) => {
    setState({ phase: "downloading", percent: Math.round(p.percent) });
  });
  autoUpdater.on("update-downloaded", () => {
    setState({ phase: "downloaded", percent: 100, error: null });
  });
  autoUpdater.on("error", (err) => {
    // A failed background check stays quiet; a failure mid-consent-flow is the user's business,
    // the install's included (0.16.0 said a download's alone: an AppImage in a folder the user
    // can't write failed at the install, and Restart now then did nothing, for good). On macOS
    // the download is said done before Squirrel has validated it, so its failure arrives while
    // the phase is already "downloaded" with no check in flight (0.16.0-rc.8): said too, or Restart
    // now would do nothing
    if (
      state.phase === "downloading" ||
      installing ||
      (state.phase === "downloaded" && checksInFlight === 0)
    ) {
      installing = false;
      setState({ phase: "error", error: err?.message ?? String(err) });
    }
  });

  const check = (): void => {
    if (!getSettings().updateCheck) return;
    void checkForUpdates().catch(() => {});
  };
  setTimeout(check, 5_000);
  setInterval(check, CHECK_EVERY_MS);
}

/** This build is a pre-release (0.9.0-rc.2): it may be offered pre-releases, and it asks the
 *  stable line first (checkForUpdates). */
const PRERELEASE = /-/.test(appVersion);
let checking: ReturnType<typeof autoUpdater.checkForUpdates> | null = null;
/** Counted before a check calls out, so an error said during the call is known to be its own. */
let checksInFlight = 0;

/**
 * A PRE-RELEASE BUILD REJOINS THE STABLE TRAIN (2026-10-06, the user: 0.9.0-rc.2 did not
 * consider the published 0.9.0 an update). electron-updater (6.8.9) moves a pre-release up
 * to a stable release only when its channel is "alpha" or "beta"; to it "rc" is a custom
 * channel, offered the next release on that channel alone, so 0.9.0-rc.2 picked itself
 * from the feed (replayed against the real one: rc.1 picks rc.2, rc.2 picks rc.2, a beta
 * would pick 0.9.0) and 0.8.0's rc testers were never offered 0.8.0 either. So a
 * pre-release build asks the stable line first (allowPrerelease off: GitHub's latest
 * release, the request every stable build makes) and the next pre-release only when the
 * stable line has nothing newer. One check at a time, since the two share the flag; the
 * download takes whichever check answered last.
 */
function checkForUpdates(): ReturnType<typeof autoUpdater.checkForUpdates> {
  // in the requests console as it ends (electron-updater's own request, outside loggedFetch)
  const at = Date.now();
  const logged = checkFeed();
  void logged.then(
    () =>
      noteRequest("github", `${REPO_URL}/releases`, {
        status: 200,
        ms: Date.now() - at,
        error: false,
      }),
    () =>
      noteRequest("github", `${REPO_URL}/releases`, {
        status: null,
        ms: Date.now() - at,
        error: true,
      }),
  );
  return logged;
}

function checkFeed(): ReturnType<typeof autoUpdater.checkForUpdates> {
  // one check at a time on every build, and known to be in flight: the error rule reads it, so a
  // failed check never turns a waiting download into a failure (0.16.0-rc.8: a stable build's
  // check went unmarked)
  if (checking) return checking;
  checksInFlight++;
  checking = (async () => {
    if (!PRERELEASE) return autoUpdater.checkForUpdates();
    autoUpdater.allowPrerelease = false;
    const stable = await autoUpdater.checkForUpdates();
    if (stable?.isUpdateAvailable) return stable;
    autoUpdater.allowPrerelease = true;
    return autoUpdater.checkForUpdates();
  })().finally(() => {
    checking = null;
    checksInFlight--;
  });
  return checking;
}

/** Immediate re-check — used when the settings toggle turns on. */
export function checkUpdatesNow(): void {
  if (!getSettings().updateCheck) return;
  if (updaterUsable()) void checkForUpdates().catch(() => {});
  else void legacyCheckNow();
}

/**
 * User-initiated check (the Updates tab's Check now button) — runs even with
 * automatic checks off (the click is the consent) and reports the outcome.
 */
export async function checkUpdatesOnDemand(): Promise<UpdateCheckResult> {
  if (!updaterUsable()) return legacyCheckOnDemand();
  try {
    const r = await checkForUpdates();
    const v = r?.updateInfo?.version;
    // The update-available/-not-available handlers above still drive the
    // pushed UpdateState; this return only feeds the button's feedback line.
    // Only an update electron-updater would offer counts (0.14.0): a feed's newer version
    // this machine is below the minimum of (minimumSystemVersion, macOS 13 since Electron 44)
    // is not one, though the feed names it.
    return r?.isUpdateAvailable && v && isNewer(v, appVersion)
      ? { status: "update", version: v }
      : { status: "none" };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

/** Consent step 1. */
export async function downloadUpdate(): Promise<void> {
  if (!updaterUsable() || !state.canDownload) return;
  setState({ phase: "downloading", percent: 0, error: null });
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    setState({ phase: "error", error: err instanceof Error ? err.message : String(err) });
  }
}

/** Consent step 2. */
export function installUpdate(): void {
  if (state.phase !== "downloaded") return;
  installing = true;
  try {
    autoUpdater.quitAndInstall();
  } catch (err) {
    installing = false;
    setState({ phase: "error", error: err instanceof Error ? err.message : String(err) });
  }
}

/** The version an update offers now (available to download, or downloaded), or null. */
export function updateOffered(): string | null {
  return state.canDownload || state.phase === "downloaded" ? state.version : null;
}

/**
 * AN UPDATE WITH NO WINDOW TO CLICK THROUGH (0.16.0-rc.8): Download and Restart live in
 * the window, so a window that never came up, or stopped and was left closed, left no route to the
 * next version. The stuck dialog (app/bootFailure) calls this: checked if need be, downloaded,
 * then installed and the app restarted. False when there is nothing to install.
 */
export async function updateFromMain(): Promise<boolean> {
  if (!updaterUsable()) return false;
  if (state.phase !== "downloaded") {
    if (!state.canDownload) {
      const found = await checkUpdatesOnDemand();
      if (found.status !== "update") return false;
    }
    await downloadUpdate();
  }
  if (state.phase !== "downloaded") return false;
  installUpdate();
  // the install quits the app when it works; one that fails says so through the error event, so
  // wait a moment for it rather than report an install that never happened (0.16.0-rc.8)
  for (let waited = 0; waited < INSTALL_SETTLE_MS; waited += 250) {
    if (phaseNow() === "error") return false;
    await new Promise((r) => setTimeout(r, 250));
  }
  return phaseNow() !== "error";
}

/** The phase as it is now: the install's events change it behind a narrowed read. */
const phaseNow = (): UpdateState["phase"] => state.phase;

/** How long updateFromMain waits for an install's failure before taking it as under way. */
const INSTALL_SETTLE_MS = 10_000;
