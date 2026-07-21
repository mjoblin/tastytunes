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
import { type UpdateCheckResult, type UpdateState } from "@shared/model";
import { getSettings } from "../data/persist";
import {
  checkNow as legacyCheckNow,
  checkOnDemand as legacyCheckOnDemand,
  isNewer,
  startUpdateCheck as startLegacyCheck,
} from "./updateCheck";

const { autoUpdater } = electronUpdater;

const RELEASES_PAGE = `${REPO_URL}/releases/latest`;
const FEED = process.env["TASTYTUNES_UPDATE_FEED"];
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

// Mac App Store builds never self-update (the store owns delivery — shipping
// an in-app updater is a rejection) and never probe GitHub for releases.
// Mirrors `storeBuild` in the preload; TASTYTUNES_MAS=1 lets harnesses
// exercise the store-build behavior in unpackaged runs.
const STORE_BUILD = process.mas === true || process.env["TASTYTUNES_MAS"] === "1";

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

const updaterUsable = (): boolean => app.isPackaged || !!FEED;

export function startUpdater(onState: (s: UpdateState) => void): void {
  announce = onState;

  if (STORE_BUILD) return; // state stays idle; Settings explains the store owns updates

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
  // from develop by dev/tag-release.sh) is offered the next rc AND the final
  // stable that supersedes it, so a tester rejoins the normal train on their
  // own. This is electron-updater's default, made explicit so it cannot
  // drift, and never for store builds (they have no updater at all).
  autoUpdater.allowPrerelease = /-/.test(appVersion);
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
    // A failed background check stays quiet; a failure mid-consent-flow is
    // the user's business.
    if (state.phase === "downloading") {
      setState({ phase: "error", error: err?.message ?? String(err) });
    }
  });

  const check = (): void => {
    if (!getSettings().updateCheck) return;
    void autoUpdater.checkForUpdates().catch(() => {});
  };
  setTimeout(check, 5_000);
  setInterval(check, CHECK_EVERY_MS);
}

/** Immediate re-check — used when the settings toggle turns on. */
export function checkUpdatesNow(): void {
  if (STORE_BUILD) return;
  if (!getSettings().updateCheck) return;
  if (updaterUsable()) void autoUpdater.checkForUpdates().catch(() => {});
  else void legacyCheckNow();
}

/**
 * User-initiated check (the Updates tab's Check now button) — runs even with
 * automatic checks off (the click is the consent) and reports the outcome.
 */
export async function checkUpdatesOnDemand(): Promise<UpdateCheckResult> {
  // Store builds never probe GitHub — the UI hides the button, but the
  // "no requests, ever" promise is enforced here too (belt and braces).
  if (STORE_BUILD) return { status: "none" };
  if (!updaterUsable()) return legacyCheckOnDemand();
  try {
    const r = await autoUpdater.checkForUpdates();
    const v = r?.updateInfo?.version;
    // The update-available/-not-available handlers above still drive the
    // pushed UpdateState; this return only feeds the button's feedback line.
    return v && isNewer(v, appVersion) ? { status: "update", version: v } : { status: "none" };
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
  autoUpdater.quitAndInstall();
}
