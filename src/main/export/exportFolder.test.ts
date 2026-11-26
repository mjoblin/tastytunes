import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ExportCapReached,
  ExportWriter,
  RENAME_WAITS_MS,
  exportDirName,
  reasonOf,
  renameWhenFree,
  renameWhenFreeAsync,
  safeName,
} from "./exportFolder";

describe("names from tags", () => {
  it("can't leave the folder, hide, or be empty", () => {
    expect(safeName("../../x")).toBe("x");
    expect(safeName(". . /etc")).toBe("etc");
    expect(safeName("...")).toBe("Untitled");
    expect(safeName(".hidden")).toBe("hidden");
    expect(safeName("a".repeat(300)).length).toBe(80);
    expect(safeName("AC/DC: Back in Black?")).toBe("AC DC Back in Black");
    expect(safeName("CON")).toBe("CON_");
    expect(safeName(null)).toBe("Untitled");
  });

  it("names an export by its tags and the minute", () => {
    const d = new Date(2026, 10, 22, 21, 40);
    expect(
      exportDirName(["The Cure", "Songs of a Lost World", "08 I Can Never Say Goodbye"], d),
    ).toBe("The Cure - Songs of a Lost World - 08 I Can Never Say Goodbye (2026-11-22 2140)");
  });
});

describe("an export's folder", () => {
  it("writes only inside itself, a new folder beside one already there", () => {
    const root = mkdtempSync(join(tmpdir(), "tt-exp-"));
    const a = new ExportWriter(root, "Same");
    const b = new ExportWriter(root, "Same");
    expect(readdirSync(root).sort()).toEqual(["Same", "Same 2"]);
    a.write("pictures/sleeve.jpg", Buffer.from("x"));
    expect(existsSync(join(a.dir, "pictures", "sleeve.jpg"))).toBe(true);
    expect(() => a.write("../outside.txt", "x")).toThrow(/outside the export/);
    expect(() => b.write("../../etc.txt", "x")).toThrow(/outside the export/);
    expect(existsSync(join(root, "outside.txt"))).toBe(false);
  });

  it("stops at its cap and says so", async () => {
    const root = mkdtempSync(join(tmpdir(), "tt-exp-"));
    const w = new ExportWriter(root, "Capped", 10);
    w.write("a.txt", "12345");
    expect(() => w.write("b.txt", "123456")).toThrow(ExportCapReached);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(4));
        c.enqueue(new Uint8Array(4));
        c.close();
      },
    });
    await expect(w.copy("audio.flac", body)).rejects.toThrow(ExportCapReached);
    expect(readFileSync(join(w.dir, "a.txt"), "utf8")).toBe("12345");
  });

  it("keeps a slice of the records' room for the README and the record written last", () => {
    const root = mkdtempSync(join(tmpdir(), "tt-exp-"));
    // a cap of 4000: media stops 1000 short of it, the other records 250 short
    const w = new ExportWriter(root, "Sliced", 4000);
    w.write("audio.flac", "x".repeat(3000), "media");
    w.write("analysis.json", "x".repeat(750), "record");
    expect(() => w.write("tracks/02/analysis.json", "x", "record")).toThrow(ExportCapReached);
    w.write("album.json", "x".repeat(250), "final");
    expect(w.bytes).toBe(4000);
  });

  it("keeps a slice of the media room for the pictures, which an audio copy can't use", async () => {
    const root = mkdtempSync(join(tmpdir(), "tt-exp-"));
    // a cap of 8000: media stops 2000 short of it, an audio copy 1000 short of that
    const w = new ExportWriter(root, "Pictures", 8000);
    const bytes = (n: number) => new Blob([new Uint8Array(n)]).stream();
    await expect(w.copy("01/audio.flac", bytes(5001))).rejects.toThrow(ExportCapReached);
    await w.copy("01/audio.flac", bytes(5000), 5000);
    await expect(w.copy("02/audio.flac", bytes(1))).rejects.toThrow(ExportCapReached);
    // the copies have used all they may, and the sleeve still fits
    w.write("pictures/sleeve.jpg", "x".repeat(1000));
    expect(w.bytes).toBe(6000);
  });

  it("writes a file under a .part name until it is whole", async () => {
    const root = mkdtempSync(join(tmpdir(), "tt-exp-"));
    const w = new ExportWriter(root, "Parts");
    let finish: () => void = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(4));
        finish = () => c.close();
      },
    });
    const copying = w.copy("audio.flac", body, 4);
    await new Promise((r) => setTimeout(r, 20));
    // part-way, nothing has the file's own name
    expect(readdirSync(w.dir)).toEqual(["audio.flac.part"]);
    finish();
    await copying;
    expect(readdirSync(w.dir)).toEqual(["audio.flac"]);
    w.write("track.json", "{}", "final");
    expect(readdirSync(w.dir).sort()).toEqual(["audio.flac", "track.json"]);
    // a write that can't be finished leaves neither name behind
    mkdirSync(join(w.dir, "album.json", "inside"), { recursive: true });
    expect(() => w.write("album.json", "{}", "final")).toThrow();
    expect(readdirSync(w.dir).sort()).toEqual(["album.json", "audio.flac", "track.json"]);
    expect(readdirSync(join(w.dir, "album.json"))).toEqual(["inside"]);
  });
});

describe("a rename something holds", () => {
  const held = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(`${code}: held, rename 'a.part' -> 'a'`), { code });

  it("is tried again while an antivirus or an indexer holds the file, then done", async () => {
    const tries: string[] = [];
    const waits: number[] = [];
    const move = (from: string, to: string): void => {
      tries.push(`${from} -> ${to}`);
      if (tries.length <= 2) throw held(tries.length === 1 ? "EPERM" : "EBUSY");
    };
    renameWhenFree("a.part", "a", move, (ms) => waits.push(ms));
    expect(tries).toEqual(["a.part -> a", "a.part -> a", "a.part -> a"]);
    expect(waits).toEqual(RENAME_WAITS_MS.slice(0, 2));

    let asked = 0;
    const later: number[] = [];
    await renameWhenFreeAsync(
      "b.part",
      "b",
      () => (++asked <= 2 ? Promise.reject(held("EACCES")) : Promise.resolve()),
      (ms) => {
        later.push(ms);
        return Promise.resolve();
      },
    );
    expect(asked).toBe(3);
    expect(later).toEqual(RENAME_WAITS_MS.slice(0, 2));
  });

  it("gives up after about two seconds, and at once for any other failure", async () => {
    const waits: number[] = [];
    let asked = 0;
    expect(() =>
      renameWhenFree(
        "a.part",
        "a",
        () => {
          asked += 1;
          throw held("EBUSY");
        },
        (ms) => waits.push(ms),
      ),
    ).toThrow(/EBUSY/);
    expect(asked).toBe(RENAME_WAITS_MS.length + 1);
    expect(waits.reduce((a, b) => a + b, 0)).toBe(2000);

    let once = 0;
    await expect(
      renameWhenFreeAsync(
        "b.part",
        "b",
        () => {
          once += 1;
          return Promise.reject(held("ENOENT"));
        },
        () => Promise.reject(new Error("never waits")),
      ),
    ).rejects.toThrow(/ENOENT/);
    expect(once).toBe(1);
  });
});

describe("a failure's reason", () => {
  const home = join(sep, "home", "ann");
  const dir = join(home, "Exports", "Dusk Parade - Harbour Lights (2026-11-22 2140)");
  const errno = (code: string, message: string): NodeJS.ErrnoException =>
    Object.assign(new Error(message), { code });

  it("names a file inside the export by its place there", () => {
    const part = join(dir, "pictures", "sleeve.jpg.part");
    const full = join(dir, "pictures", "sleeve.jpg");
    const message = `EPERM: operation not permitted, rename '${part}' -> '${full}'`;
    expect(reasonOf(errno("EPERM", message), dir, home)).toBe(
      `EPERM: operation not permitted, rename '${join("pictures", "sleeve.jpg.part")}' -> '${join("pictures", "sleeve.jpg")}'`,
    );
  });

  it("leaves out any other path, and the home folder wherever it is", () => {
    const cache = join(home, "Library", "Caches", "x.json");
    expect(
      reasonOf(errno("ENOENT", `ENOENT: no such file or directory, open '${cache}'`), dir, home),
    ).toBe("ENOENT: no such file or directory, open");
    expect(reasonOf(new Error(`couldn't read ${cache}`), dir, home)).toBe(
      `couldn't read ${join("~", "Library", "Caches", "x.json")}`,
    );
  });

  it("gives the error's code with its reason, and a plain one as it is", () => {
    expect(reasonOf(errno("ERR_STREAM_PREMATURE_CLOSE", "Premature close"), dir, home)).toBe(
      "ERR_STREAM_PREMATURE_CLOSE: Premature close",
    );
    expect(reasonOf(new Error("connection reset"), dir, home)).toBe("connection reset");
    expect(reasonOf("stopped", dir, home)).toBe("stopped");
  });

  it("never names the folder of a write that really failed", () => {
    const root = mkdtempSync(join(tmpdir(), "tt-exp-"));
    const w = new ExportWriter(root, "Failing");
    mkdirSync(join(w.dir, "album.json", "inside"), { recursive: true });
    let reason = "";
    try {
      w.write("album.json", "{}", "final");
    } catch (e) {
      reason = reasonOf(e, w.dir);
    }
    expect(reason).toMatch(/^E[A-Z]+: /);
    expect(reason).not.toContain(root);
  });
});
