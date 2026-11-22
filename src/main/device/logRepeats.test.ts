import { describe, expect, it } from "vitest";
import type { LogEntry } from "@shared/model";
import { LogRepeats } from "./logRepeats";

const at = (s: number, text: string, scope = "socket"): LogEntry => ({
  at: s * 1000,
  level: "error",
  scope,
  text,
});

describe("the log's repeats", () => {
  it("counts two polling lines that alternate through an outage, and writes the rest in order", () => {
    const out: string[] = [];
    const log = new LogRepeats((e) => out.push(e.text), 10 * 60_000);
    for (let s = 0; s < 120; s += 10) {
      log.log(at(s, "websocket error: connect ETIMEDOUT"), true);
      log.log(at(s + 5, "found 0 streamer(s)", "discovery"), true);
      if (s === 60) log.log(at(s + 6, "the Library asked for servers", "media"), false);
    }
    expect(out).toEqual([
      "websocket error: connect ETIMEDOUT",
      "found 0 streamer(s)",
      "the Library asked for servers",
    ]);
    log.flush(130_000);
    expect(out.slice(3)).toEqual([
      "websocket error: connect ETIMEDOUT (11 more times in 10 minutes)",
      "found 0 streamer(s) (11 more times in 10 minutes)",
    ]);
  });

  it("writes a run's count once its window has passed, then the line afresh", () => {
    const out: string[] = [];
    const log = new LogRepeats((e) => out.push(e.text), 60_000);
    log.log(at(0, "websocket error: closed"), true);
    log.log(at(30, "websocket error: closed"), true);
    log.log(at(61, "websocket error: closed"), true);
    expect(out).toEqual([
      "websocket error: closed",
      "websocket error: closed (1 more time in 1 minute)",
      "websocket error: closed",
    ]);
  });

  it("never counts a line that isn't marked", () => {
    const out: string[] = [];
    const log = new LogRepeats((e) => out.push(e.text), 60_000);
    log.log(at(0, "connected to ws://evo"), false);
    log.log(at(1, "connected to ws://evo"), false);
    expect(out).toEqual(["connected to ws://evo", "connected to ws://evo"]);
  });
});
