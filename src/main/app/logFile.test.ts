import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOG_NAME, LogFile, PREVIOUS_LOG_NAME, redact } from "./logFile";

const entry = (text: string, level: "info" | "warn" | "error" = "info") => ({
  at: Date.UTC(2026, 10, 10, 12, 0, 0),
  level,
  scope: "wire",
  text,
});

describe("redact", () => {
  it("hides a token, key or password and keeps the rest of the line", () => {
    expect(redact("Authorization: Bearer abc.def-123 sent")).toBe(
      "Authorization: Bearer [hidden] sent",
    );
    expect(redact("GET /x?token=s3cr3t&page=2")).toBe("GET /x?token=[hidden]&page=2");
    expect(redact('{"api_key": "k-99", "name": "Evo"}')).toBe(
      '{"api_key": "[hidden]", "name": "Evo"}',
    );
    expect(redact("session_key=ABCDEF password: hunter2")).toBe(
      "session_key=[hidden] password: [hidden]",
    );
  });

  it("leaves an ordinary line alone", () => {
    const line = "/zone/now_playing: source was a number, set aside";
    expect(redact(line)).toBe(line);
  });
});

describe("LogFile", () => {
  it("writes a session's header, then each line with its time, level and scope", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-log-"));
    const log = new LogFile(dir, () => "TastyTunes 0.16.0 on darwin");
    log.write(entry("a frame without a path: null", "warn"));
    const text = readFileSync(join(dir, LOG_NAME), "utf-8");
    expect(text).toContain("--- TastyTunes 0.16.0 on darwin\n");
    expect(text).toContain("2026-11-10T12:00:00.000Z warn  [wire] a frame without a path: null\n");
  });

  it("keeps the one before it when the file reaches its limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-log-"));
    const log = new LogFile(dir, () => "header", 400);
    for (let i = 0; i < 20; i++) log.write(entry(`line ${i}`));
    const now = readFileSync(join(dir, LOG_NAME), "utf-8");
    const before = readFileSync(join(dir, PREVIOUS_LOG_NAME), "utf-8");
    expect(Buffer.byteLength(now)).toBeLessThanOrEqual(400);
    expect(now).toContain("--- header (continued)");
    expect(now).toContain("line 19");
    expect(before).toMatch(/line \d+/);
  });

  it("never throws when the folder can't be written: it stops writing", () => {
    // a file where a folder should be: no system makes a folder inside a file (/dev/null/logs did
    // on Windows, as C:\dev\null\logs)
    const blocker = join(mkdtempSync(join(tmpdir(), "log-")), "not-a-folder");
    writeFileSync(blocker, "");
    const log = new LogFile(join(blocker, "logs"), () => "header");
    expect(() => log.write(entry("x"))).not.toThrow();
    expect(existsSync(join(blocker, "logs"))).toBe(false);
  });
});
