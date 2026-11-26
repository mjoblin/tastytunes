import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExportCapReached, ExportWriter, exportDirName, safeName } from "./exportFolder";

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
