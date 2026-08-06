// The ONE entry point for Windows packaging. Use it everywhere — CI and by
// hand — because a raw `electron-builder --win` produces an installer that
// silently fails to install on Windows-on-ARM.
//
// WHY: 7-Zip groups executables into a single solid block so it can apply an
// architecture filter to them, and for arm64 payloads it picks the ARM64
// branch filter (7-Zip 21.x). The 7z decoder embedded in the NSIS installer
// predates that filter, so it decodes every ordinary block and fails on
// exactly the executable one — the install "succeeds" with no .exe and no
// DLLs, leaving a shortcut that points at nothing. Live-hit 2026-08-03 and
// reproduced on a windows-11-arm CI runner.
//
// ELECTRON_BUILDER_7Z_FILTER pins the filter to BCJ (the x86 one, understood
// by every 7-Zip decoder ever shipped). Compression is unaffected in any way
// that matters, and the payload becomes decodable everywhere.
//
// NOT `useZip: true`, which looks like the obvious alternative: the zip path
// in electron-builder's NSIS script reports failure through a MessageBox with
// NO `/SD` default, so a silent install (`/S`, i.e. every CI install and
// every unattended one) BLOCKS FOREVER waiting for a click. Tried it; both
// architectures hung for 38 minutes before the run was cancelled.
//
//   node scripts/build-win.mjs [extra electron-builder args...]
//   npm run dist:win -- --arm64
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// Resolve electron-builder's own CLI and run it with THIS node — no `npx`,
// no shell. `spawn('npx', …)` fails with ENOENT on Windows, where npx is a
// .cmd shim rather than an executable, which broke the very platform this
// script exists for (caught in CI, 2026-08-04).
const cli = createRequire(import.meta.url).resolve('electron-builder/cli.js')
const args = [cli, '--win', ...process.argv.slice(2)]

// AZURE ARTIFACT SIGNING, CI-only by design: the release workflow's
// azure/login step (OIDC, no stored secret) sets AZURE_TENANT_ID in the job
// env, and its presence is the switch. Local builds stay unsigned — the
// options aren't in electron-builder.yml precisely so a Mac cross-build or a
// hand build doesn't die reaching for credentials it doesn't have. The
// account/profile names are not secrets; auth is entirely the OIDC session.
if (process.env.AZURE_TENANT_ID) {
  args.push(
    '--config.win.azureSignOptions.endpoint=https://wus2.codesigning.azure.net',
    '--config.win.azureSignOptions.codeSigningAccountName=redactedcatsigning',
    '--config.win.azureSignOptions.certificateProfileName=tastytunes',
    // Required by the schema; must equal the certificate CN — the updater
    // verifies downloaded updates against this publisher.
    '--config.win.azureSignOptions.publisherName=Michael Vaughan Joblin',
    '--config.win.azureSignOptions.timestampRfc3161=http://timestamp.acs.microsoft.com',
    '--config.win.azureSignOptions.timestampDigest=SHA256'
  )
  console.log('> Azure Artifact Signing: ON (AZURE_TENANT_ID present)')
} else {
  console.log('> Azure Artifact Signing: off (no AZURE_TENANT_ID - local/unsigned build)')
}

console.log(`> ELECTRON_BUILDER_7Z_FILTER=BCJ node ${args.join(' ')}`)

const child = spawn(process.execPath, args, {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_BUILDER_7Z_FILTER: 'BCJ' }
})
child.on('exit', (code) => process.exit(code ?? 1))
