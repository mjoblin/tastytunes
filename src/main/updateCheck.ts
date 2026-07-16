// Version from package.json, not app.getVersion(): under a dev harness that
// launches Electron with a bare file path, getVersion() is Electron's own.
import { version as appVersion } from '../../package.json'
import type { UpdateInfo } from '@shared/ipc'
import { getSettings } from './persist'
import { loggedFetch } from './netlog'

// TASTYTUNES_UPDATE_URL lets test harnesses point the check at a local server.
const RELEASES_URL =
  process.env['TASTYTUNES_UPDATE_URL'] ??
  'https://api.github.com/repos/mjoblin/tastytunes/releases/latest'
const RELEASES_PAGE = 'https://github.com/mjoblin/tastytunes/releases/latest'
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000

let latest: UpdateInfo | null = null
let announce: (info: UpdateInfo) => void = () => {}

function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

/** The update found by the most recent check, for windows created after it. */
export function currentUpdate(): UpdateInfo | null {
  return latest
}

export async function checkNow(): Promise<void> {
  if (!getSettings().updateCheck) return
  try {
    const res = await loggedFetch('github', RELEASES_URL, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(10_000)
    })
    // 404 = no releases published yet; other failures retry next cycle.
    if (!res.ok) return
    const body = (await res.json()) as { tag_name?: string; html_url?: string }
    if (!body.tag_name || !isNewer(body.tag_name, appVersion)) return
    latest = { version: body.tag_name.replace(/^v/, ''), url: body.html_url ?? RELEASES_PAGE }
    announce(latest)
  } catch {
    // offline or GitHub unreachable — silent, next cycle will try again
  }
}

export function startUpdateCheck(onUpdate: (info: UpdateInfo) => void): void {
  announce = onUpdate
  // Launch check waits a beat so it never competes with device startup.
  setTimeout(() => void checkNow(), 5_000)
  setInterval(() => void checkNow(), CHECK_EVERY_MS)
}
