import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
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
});
