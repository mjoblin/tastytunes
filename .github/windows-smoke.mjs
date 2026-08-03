// Windows install smoke: drives the INSTALLED app (the NSIS build, installed
// silently by the workflow) on a real x64 Windows runner — install, boot,
// demo-mode connect, transport round-trip. This is the packaged-app proof the
// dev harness can't give: it exercises the installer, the packaged resources
// (the `?asset` path trap), and the release chunks, none of which exist in a
// dev run.
//
// Demo mode on purpose: the runner has no streamer and no LAN, and the demo
// server ships in the app precisely so it can be exercised with neither.
//
//   TT_EXE=<installed TastyTunes.exe> node .github/windows-smoke.mjs
import { _electron } from 'playwright-core'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const exe = process.env.TT_EXE
if (!exe || !existsSync(exe)) {
  console.error(`TT_EXE missing or not found: ${exe}`)
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failed++
  return cond
}

// Sandboxed userData plus sunk external URLs: the smoke must neither touch a
// real settings file nor reach any real service from CI.
const ud = mkdtempSync(join(tmpdir(), 'tt-smoke-'))
const sink = 'http://127.0.0.1:9/'
const app = await _electron.launch({
  executablePath: exe,
  env: {
    ...process.env,
    TASTYTUNES_USER_DATA: ud,
    TASTYTUNES_SSDP_TARGET: '127.0.0.1:1',
    TASTYTUNES_UPDATE_URL: sink,
    TASTYTUNES_LB_URL: sink,
    TASTYTUNES_LYRICS_URL: sink,
    TASTYTUNES_RADIO_URL: sink,
    TASTYTUNES_ARTIST_URL: sink,
    TASTYTUNES_MB_URL: sink
  }
})

try {
  const page = await app.firstWindow({ timeout: 60000 })
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('  [renderer error]', m.text().slice(0, 200))
  })
  await sleep(4000)
  ok('the installed app boots to a window', true)

  // No streamer on the runner, so the app opens on the connect gate; the demo
  // door is the whole point of that screen.
  const demoBtn = page.locator('text=Try without a streamer')
  await demoBtn.waitFor({ timeout: 30000 })
  ok('the connect gate offers the demo', true)
  await demoBtn.click()

  // Demo connects and plays: Demo Track N / The Amber Collective, state play.
  let body = ''
  for (let i = 0; i < 40; i++) {
    body = await page.evaluate(() => document.body.innerText)
    if (body.includes('Demo Track') && body.includes('The Amber Collective')) break
    await sleep(500)
  }
  ok(
    'demo mode connects and shows the playing track',
    body.includes('Demo Track') && body.includes('The Amber Collective'),
    body.slice(0, 120).replace(/\n/g, ' · ')
  )

  // Transport round-trip through the app's own IPC, wire and back: the bar's
  // play/pause hero flips its label when the demo streamer honours the verb.
  const pause = page.locator('[aria-label="Pause (space)"]')
  await pause.waitFor({ timeout: 15000 })
  ok('transport shows Pause while playing', true)
  await pause.click()
  await page.locator('[aria-label="Play (space)"]').waitFor({ timeout: 15000 })
  ok('togglePlayback round-trips (Pause → Play)', true)

  // The boot also proves the packaged resources: the tray is ON by default,
  // and a missing resources/ dir (the ?asset trap) breaks tray creation in
  // release builds only. Reaching this line with a live window means the main
  // process survived it; assert the window really is alive.
  ok('the window is still alive at the end', !page.isClosed())
} catch (e) {
  failed++
  console.error('  ✗ smoke threw:', String(e).slice(0, 400))
} finally {
  await app.close().catch(() => {})
}

console.log(failed === 0 ? 'WINDOWS SMOKE: PASS' : `WINDOWS SMOKE: ${failed} FAILURE(S)`)
process.exit(failed === 0 ? 0 : 1)
