// The packaged Mac app's executables get UUIDs of their own (scripts/mac-uuid.mjs), so the
// Local Network permission never shares an identity with another app on the same Electron
// release. Synthetic Mach-O files here, so the tests run on any runner; the real Electron
// executable and dwarfdump on a Mac.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkUuids,
  derivedUuid,
  formatUuid,
  ownUuids,
  rewriteUuids,
  sliceOffsets,
  uuidSite,
} from "./mac-uuid.mjs";

const ARM64 = 0x0100000c;
const X86_64 = 0x01000007;
const STOCK = Buffer.from("4C4C441555553144A1F17AC69FF31A68", "hex");

/** A thin 64-bit Mach-O: a segment command, then LC_UUID with the stock UUID, then filler. */
function thin(cputype, { uuid = true } = {}) {
  const segment = Buffer.alloc(72);
  segment.writeUInt32LE(0x19, 0);
  segment.writeUInt32LE(72, 4);
  const cmds = [segment];
  if (uuid) {
    const lc = Buffer.alloc(24);
    lc.writeUInt32LE(0x1b, 0);
    lc.writeUInt32LE(24, 4);
    STOCK.copy(lc, 8);
    cmds.push(lc);
  }
  const body = Buffer.concat(cmds);
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeInt32LE(cputype, 4);
  header.writeUInt32LE(2, 12);
  header.writeUInt32LE(cmds.length, 16);
  header.writeUInt32LE(body.length, 20);
  return Buffer.concat([header, body, Buffer.alloc(64, 0xab)]);
}

/** A fat file holding the slices at 4 KiB boundaries, as lipo lays them out. */
function fat(...slices) {
  const header = Buffer.alloc(4096);
  header.writeUInt32BE(0xcafebabe, 0);
  header.writeUInt32BE(slices.length, 4);
  const parts = [header];
  let offset = 4096;
  slices.forEach((s, i) => {
    const at = 8 + i * 20;
    header.writeInt32BE(s.readInt32LE(4), at);
    header.writeUInt32BE(offset, at + 8);
    header.writeUInt32BE(s.length, at + 12);
    header.writeUInt32BE(12, at + 16);
    const padded = Buffer.alloc(Math.ceil(s.length / 4096) * 4096);
    s.copy(padded);
    parts.push(padded);
    offset += padded.length;
  });
  return Buffer.concat(parts);
}

const MAIN = "Contents/MacOS/TastyTunes";
const ID = "com.example.player";

describe("each Mac executable gets a UUID of its own", () => {
  it("a thin executable gets its derived UUID, and no other byte changes", () => {
    const before = thin(ARM64);
    const buf = Buffer.from(before);
    const [row] = rewriteUuids(buf, ID, "darwin", MAIN);
    const { at } = uuidSite(buf, 0);
    expect(row.uuid).not.toBe(formatUuid(STOCK));
    expect(formatUuid(buf.subarray(at, at + 16))).toBe(row.uuid);
    const changed = [...buf].flatMap((b, i) => (b === before[i] ? [] : [i]));
    expect(changed.every((i) => i >= at && i < at + 16)).toBe(true);
  });

  it("a universal executable's slices get the UUIDs each architecture's pass wrote, different from each other", () => {
    const arm = Buffer.from(thin(ARM64));
    const intel = Buffer.from(thin(X86_64));
    const [armRow] = rewriteUuids(arm, ID, "darwin", MAIN);
    const [intelRow] = rewriteUuids(intel, ID, "darwin", MAIN);
    const merged = fat(thin(X86_64), thin(ARM64));
    const rows = rewriteUuids(merged, ID, "darwin", MAIN);
    expect(sliceOffsets(merged)).toEqual([4096, 8192]);
    expect(rows.map((r) => r.uuid)).toEqual([intelRow.uuid, armRow.uuid]);
    expect(armRow.uuid).not.toBe(intelRow.uuid);
  });

  it("writing twice writes what once did", () => {
    const once = Buffer.from(thin(ARM64));
    rewriteUuids(once, ID, "darwin", MAIN);
    const twice = Buffer.from(once);
    rewriteUuids(twice, ID, "darwin", MAIN);
    expect(twice.equals(once)).toBe(true);
  });

  it("the helpers, the store flavor and another app each get different UUIDs", () => {
    const uuidFor = (id, platform, rel) => rewriteUuids(Buffer.from(thin(ARM64)), id, platform, rel)[0].uuid;
    const all = [
      uuidFor(ID, "darwin", MAIN),
      uuidFor(ID, "darwin", "Contents/Frameworks/TastyTunes Helper.app/Contents/MacOS/TastyTunes Helper"),
      uuidFor(ID, "mas", MAIN),
      uuidFor("com.example.other", "darwin", MAIN),
    ];
    expect(new Set(all).size).toBe(4);
  });

  it("a derived UUID carries the name-based version and the RFC 4122 variant", () => {
    const b = derivedUuid("anything");
    expect(b[6] >> 4).toBe(5);
    expect(b[8] >> 6).toBe(2);
  });

  it("an executable with no LC_UUID, or a file that isn't Mach-O, fails the build", () => {
    expect(() => rewriteUuids(Buffer.from(thin(ARM64, { uuid: false })), ID, "darwin", MAIN)).toThrow(/no LC_UUID/);
    expect(() => rewriteUuids(Buffer.from("#!/bin/sh\necho hi\n"), ID, "darwin", MAIN)).toThrow(/not a Mach-O/);
  });
});

/** A minimal .app: an Info.plist, the main executable and two helpers. */
function fakeApp(make) {
  const app = join(mkdtempSync(join(tmpdir(), "mac-uuid-")), "Player.app");
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  writeFileSync(
    join(app, "Contents/Info.plist"),
    `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key>\n<string>${ID}</string></dict></plist>`,
  );
  make(join(app, "Contents/MacOS/Player"));
  for (const h of ["Player Helper", "Player Helper (GPU)"]) {
    const dir = join(app, `Contents/Frameworks/${h}.app/Contents/MacOS`);
    mkdirSync(dir, { recursive: true });
    make(join(dir, h));
  }
  return app;
}

describe("the packaged app's check", () => {
  it("fails an app as Electron ships it, and passes it once the hook has run", async () => {
    const app = fakeApp((f) => writeFileSync(f, fat(thin(X86_64), thin(ARM64))));
    const stock = await checkUuids(app);
    expect(stock.ok).toBe(false);
    expect(stock.rows.every((r) => r.actual === formatUuid(STOCK))).toBe(true);
    const written = await ownUuids(app, "darwin");
    expect(written).toHaveLength(6);
    const own = await checkUuids(app);
    expect(own.ok).toBe(true);
    expect(new Set(own.rows.map((r) => r.actual)).size).toBe(6);
    expect((await checkUuids(app, "mas")).ok).toBe(false);
  });
});

const ELECTRON = join(
  process.cwd(),
  "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);

describe.skipIf(process.platform !== "darwin" || !existsSync(ELECTRON))("on a Mac", () => {
  it("dwarfdump reads the new UUID from a copy of Electron's own executable", async () => {
    const app = fakeApp((f) => copyFileSync(ELECTRON, f));
    const main = join(app, "Contents/MacOS/Player");
    const dump = () => execFileSync("dwarfdump", ["--uuid", main], { encoding: "utf-8" });
    const stock = dump();
    const written = await ownUuids(app, "darwin");
    const after = dump();
    const mainRows = written.filter((w) => w.rel === "Contents/MacOS/Player");
    expect(mainRows.length).toBeGreaterThan(0);
    for (const w of mainRows) expect(after).toContain(w.uuid);
    expect(after).not.toBe(stock);
    expect(readFileSync(main).length).toBe(readFileSync(ELECTRON).length);
  });
});
