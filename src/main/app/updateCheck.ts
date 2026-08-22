// Version from package.json, not app.getVersion(): under a dev harness that
// launches Electron with a bare file path, getVersion() is Electron's own.
import { version as appVersion } from "../../../package.json";
import { REPO_URL } from "@shared/ipc";
import { type UpdateCheckResult, type UpdateInfo } from "@shared/model";
import { getSettings } from "../data/persist";
import { loggedFetch } from "../netlog";

// TASTYTUNES_UPDATE_URL lets test harnesses point the check at a local server.
const RELEASES_URL =
  process.env["TASTYTUNES_UPDATE_URL"] ??
  `https://api.github.com/repos/${new URL(REPO_URL).pathname.slice(1)}/releases/latest`;
const RELEASES_PAGE = `${REPO_URL}/releases/latest`;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

let latest: UpdateInfo | null = null;
let announce: (info: UpdateInfo) => void = () => {};

function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

/** The update found by the most recent check, for windows created after it. */
export function currentUpdate(): UpdateInfo | null {
  return latest;
}

/** One release-feed round trip. null = nothing newer than this build
 *  (a 404 means no releases published yet); throws on network/HTTP trouble. */
async function fetchLatest(): Promise<UpdateInfo | null> {
  const res = await loggedFetch("github", RELEASES_URL, {
    headers: { accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const body = (await res.json()) as { tag_name?: string; html_url?: string };
  if (!body.tag_name || !isNewer(body.tag_name, appVersion)) return null;
  return { version: body.tag_name.replace(/^v/, ""), url: body.html_url ?? RELEASES_PAGE };
}

export async function checkNow(): Promise<void> {
  if (!getSettings().updateCheck) return;
  try {
    const info = await fetchLatest();
    if (!info) return;
    latest = info;
    announce(latest);
  } catch {
    // offline or GitHub unreachable — silent, next cycle will try again
  }
}

/**
 * User-initiated check (the Updates tab's Check now button). Runs even with
 * automatic checks off — clicking the button IS the consent — and reports its
 * outcome so the UI can say "nothing new" or show the failure.
 */
export async function checkOnDemand(): Promise<UpdateCheckResult> {
  try {
    const info = await fetchLatest();
    if (!info) return { status: "none" };
    latest = info;
    announce(latest);
    return { status: "update", version: info.version };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }
}

export function startUpdateCheck(onUpdate: (info: UpdateInfo) => void): void {
  announce = onUpdate;
  // Launch check waits a beat so it never competes with device startup.
  setTimeout(() => void checkNow(), 5_000);
  setInterval(() => void checkNow(), CHECK_EVERY_MS);
}
