// THE MAC APP'S OWN UUIDS. macOS keeps a program's Local Network permission by its main
// executable's Mach-O UUID (LC_UUID), and an Electron app ships Electron's stock executable as
// is, so every app built on the same Electron release has the same UUID. Two programs with one
// UUID confuse the system: when another app on that release has Local Network turned off, this
// app's permission can stop holding, its connections to the streamer refused (no route to host)
// until it is turned off and on in System Settings. So each executable in the packaged app, the
// app's own and its helpers', gets a UUID of its own, written here, before the fuses are flipped
// and the app is signed.
//
// Derived, not random: from the app id, the platform (darwin or mas, so the two flavors differ),
// the executable's path inside the bundle and the slice's CPU type. The app keeps the same UUIDs
// from one version to the next, and a universal build's last pass (electron-builder calls
// afterPack on each architecture's app, then on the merged one) writes what the first ones did.
//
//   afterPack: ./scripts/mac-uuid.mjs                        (electron-builder.yml)
//   node scripts/mac-uuid.mjs --check <TastyTunes.app>       (release.yml, the signed app)
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const MH_MAGIC = 0xfeedface
const MH_MAGIC_64 = 0xfeedfacf
const FAT_MAGIC = 0xcafebabe
const FAT_MAGIC_64 = 0xcafebabf
const LC_UUID = 0x1b

/** Where each slice of a Mach-O file starts: one for a thin file, one per architecture for a fat one; none for anything else. */
export function sliceOffsets(buf) {
  if (buf.length < 8) return []
  const fat = buf.readUInt32BE(0)
  if (fat === FAT_MAGIC || fat === FAT_MAGIC_64) {
    const wide = fat === FAT_MAGIC_64
    const out = []
    for (let i = 0; i < buf.readUInt32BE(4); i++) {
      const at = 8 + i * (wide ? 32 : 20)
      out.push(wide ? Number(buf.readBigUInt64BE(at + 8)) : buf.readUInt32BE(at + 8))
    }
    return out
  }
  const magic = buf.readUInt32LE(0)
  return magic === MH_MAGIC_64 || magic === MH_MAGIC ? [0] : []
}

/** The slice's CPU type and where its LC_UUID's 16 bytes sit, or -1 when it has none. */
export function uuidSite(buf, slice) {
  const magic = buf.readUInt32LE(slice)
  if (magic !== MH_MAGIC_64 && magic !== MH_MAGIC) throw new Error(`no Mach-O header at ${slice}`)
  const cputype = buf.readInt32LE(slice + 4)
  const ncmds = buf.readUInt32LE(slice + 16)
  let at = slice + (magic === MH_MAGIC_64 ? 32 : 28)
  for (let i = 0; i < ncmds; i++) {
    const cmd = buf.readUInt32LE(at)
    const size = buf.readUInt32LE(at + 4)
    if (cmd === LC_UUID) return { cputype, at: at + 8 }
    if (size < 8) break
    at += size
  }
  return { cputype, at: -1 }
}

/** The 16 bytes for a seed, with the name-based version and RFC 4122 variant bits set. */
export function derivedUuid(seed) {
  const b = createHash('sha256').update(seed).digest().subarray(0, 16)
  b[6] = (b[6] & 0x0f) | 0x50
  b[8] = (b[8] & 0x3f) | 0x80
  return b
}

/** As dwarfdump prints one. */
export function formatUuid(b) {
  const h = Buffer.from(b).toString('hex').toUpperCase()
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const seedOf = (appId, platform, rel, cputype) => `${appId}\0${platform}\0${rel}\0${cputype}`

/** Writes each slice's own UUID into buf in place; throws when a slice has no LC_UUID, so a build never ships one shared by accident. */
export function rewriteUuids(buf, appId, platform, rel) {
  const slices = sliceOffsets(buf)
  if (slices.length === 0) throw new Error(`${rel} is not a Mach-O executable`)
  return slices.map((slice) => {
    const { cputype, at } = uuidSite(buf, slice)
    if (at < 0) throw new Error(`${rel} has no LC_UUID`)
    const uuid = derivedUuid(seedOf(appId, platform, rel, cputype))
    uuid.copy(buf, at)
    return { rel, cputype, uuid: formatUuid(uuid) }
  })
}

/** The app's executables: its own under Contents/MacOS and each helper app's. */
export async function executables(app) {
  const out = (await readdir(join(app, 'Contents/MacOS'))).map((f) => `Contents/MacOS/${f}`)
  const frameworks = join(app, 'Contents/Frameworks')
  for (const helper of (await readdir(frameworks)).filter((n) => n.endsWith('.app')).sort()) {
    for (const f of await readdir(join(frameworks, helper, 'Contents/MacOS'))) {
      out.push(`Contents/Frameworks/${helper}/Contents/MacOS/${f}`)
    }
  }
  return out
}

/** The app's bundle id, from its Info.plist: one source for the hook and the check. */
export async function appIdOf(app) {
  const plist = await readFile(join(app, 'Contents/Info.plist'), 'utf-8')
  const appId = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]
  if (!appId) throw new Error('no CFBundleIdentifier in Info.plist')
  return appId
}

/** Gives every executable in the app its own UUIDs. */
export async function ownUuids(app, platform) {
  const appId = await appIdOf(app)
  const written = []
  for (const rel of await executables(app)) {
    const buf = await readFile(join(app, rel))
    written.push(...rewriteUuids(buf, appId, platform, rel))
    await writeFile(join(app, rel), buf)
  }
  return written
}

/** Each executable's slices against the UUIDs derived for them; ok only when every one matches. */
export async function checkUuids(app, platform = 'darwin') {
  const appId = await appIdOf(app)
  const rows = []
  for (const rel of await executables(app)) {
    const buf = await readFile(join(app, rel))
    for (const slice of sliceOffsets(buf)) {
      const { cputype, at } = uuidSite(buf, slice)
      const actual = at < 0 ? 'none' : formatUuid(buf.subarray(at, at + 16))
      const expected = formatUuid(derivedUuid(seedOf(appId, platform, rel, cputype)))
      rows.push({ rel, cputype, actual, ok: actual === expected })
    }
  }
  return { ok: rows.length > 0 && rows.every((r) => r.ok), rows }
}

/** electron-builder's afterPack hook: every Mac flavor, before the fuses and the signature. */
export async function afterPack(context) {
  const platform = context.electronPlatformName
  if (platform !== 'darwin' && platform !== 'mas') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const written = await ownUuids(app, platform)
  console.log(`  • own UUIDs  ${written.length} slices in ${new Set(written.map((w) => w.rel)).size} executables`)
}

export default afterPack

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [flag, app, platform] = process.argv.slice(2)
  if (flag !== '--check' || !app) {
    console.error('usage: node scripts/mac-uuid.mjs --check <App.app> [darwin|mas]')
    process.exit(2)
  }
  const { ok, rows } = await checkUuids(app, platform)
  for (const r of rows) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.actual} ${r.cputype} ${r.rel}`)
  if (!ok) {
    console.error('An executable carries a UUID not derived for this app (the stock Electron one?).')
    process.exit(1)
  }
}
