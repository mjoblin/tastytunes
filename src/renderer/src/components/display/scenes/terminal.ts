import type { Rgb, Scene, SceneFrame, SceneKey, SceneSettingDef, SceneSettings } from "./types";
import { easeTowards } from "../clock";
import { sceneFont } from "../type";
import { clamp, mix, rgb, rgba, wrap } from "./lib";
import { version } from "../../../../../../package.json";

/**
 * TERMINAL. A 1980s operating system, TASTYOS, typing the words out on an amber
 * phosphor screen (after ThreeUI's CRT boot terminal, in this app's voice; the
 * Cathode finish is the glass, so this scene draws only the screen). A line is
 * typed at a natural pace, keystroke by keystroke with pauses at the punctuation,
 * and never stretched to fill its time: the words are timed by the line, not by
 * the word (the user's call). A line that arrives before the last is finished is
 * completed at once. The lines already sung scroll up as the log, each with its
 * time, dimming as they age like phosphor. The cursor blinks on the beat. The
 * status line at the top is the data: the track, the position, the tempo and key,
 * the section as the running process, a six-band meter and LEVEL, the loudness
 * (not LOAD: a user would read that as their machine's CPU). A kick sags the raster a
 * pixel (with a rise, never a pop); a drop prints a divider and flashes the
 * phosphor. A track with no words gets a boot log instead: what the analysis
 * found, then the sections and drops ticked off as they pass.
 */
export const TERMINAL_KEY: SceneKey = {
  reads: [
    {
      shows: "The typed line",
      means:
        "the lyric being sung, typed at a natural pace. A line that arrives before the last has finished is completed at once",
    },
    {
      shows: "The log above",
      means: "the lyrics already sung, with their times, dimming as they age",
    },
    { shows: "The cursor", means: "blinks on the beat, longer on the first beat of a bar" },
    {
      shows: "The status line",
      means:
        "the track, your position, the tempo and key, the current section, a level meter for six frequency bands and the overall loudness",
    },
    { shows: "A sag of the screen", means: "a kick drum" },
    { shows: "A divider and a flash", means: "a drop" },
    {
      shows: "The boot log",
      means:
        "for a track without lyrics, what was measured about the track, then each section and drop as it passes",
    },
  ],
  honesty: [
    "The typing pace is the terminal's, not the singer's. Only the lines are timed, not the words.",
  ],
};

export const TERMINAL_SETTINGS: SceneSettingDef[] = [
  {
    key: "phosphor",
    label: "Phosphor",
    kind: "select",
    options: [
      { value: "amber", label: "Amber" },
      { value: "gold", label: "Gold" },
      { value: "green", label: "Green" },
    ],
    default: "amber",
  },
  { key: "status", label: "Status", kind: "toggle", default: true },
];

const AMBER: Rgb = [255, 176, 0];
const GREEN: Rgb = [72, 255, 118];
const NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const METER = "▁▂▃▄▅▆▇█";
/** The log keeps this many entries; the screen shows what fits. */
const LOG_MAX = 80;

interface Entry {
  /** The line, or a system message. */
  text: string;
  /** "mm:ss" of the moment, or "" for a system message without one. */
  stamp: string;
  sys: boolean;
}

const stamp = (secs: number): string => {
  const s = Math.max(0, Math.floor(secs));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** A keystroke's delay after `ch`, in ms: a natural, slightly uneven pace with pauses at the punctuation. */
function keyDelay(ch: string, reduced: boolean): number {
  const base = reduced ? 22 : 44 + Math.random() * 40;
  if (ch === " ") return base * 0.7;
  if (",;:".includes(ch)) return base + 150;
  if (".!?".includes(ch)) return base + 260;
  return base;
}

export class Terminal implements Scene {
  settings: SceneSettings = {};
  private trackKey = "";
  private linesFor: readonly { t: number; text: string }[] | null = null;
  private log: Entry[] = [];
  /** The line being typed: its index, how many characters are out, and when the next comes. */
  private typedIndex = -1;
  private typed = 0;
  private nextKeyAt = 0;
  private current: Entry | null = null;
  /** Rows the log slides up through as a new line starts, eased to 0. */
  private scroll = 0;
  private sag = 0;
  private sagAim = 0;
  private flicker = 0;
  private flash = 0;
  private booted = false;
  /** The log rebuilt from the track's own times at mount (and after a seek back), once. */
  private backfilled = false;
  private measured = false;
  private lastSection: number | null = null;
  /** System messages that arrived while a line was still typing; they follow it. */
  private pending: Entry[] = [];

  private reset(): void {
    this.log = [];
    this.pending = [];
    this.typedIndex = -1;
    this.typed = 0;
    this.current = null;
    this.scroll = 0;
    this.booted = false;
    this.backfilled = false;
    this.measured = false;
    this.lastSection = null;
  }

  private push(text: string, stampAt: number | null, sys: boolean): void {
    const entry: Entry = { text, stamp: stampAt == null ? "" : stamp(stampAt), sys };
    // the log stays in time order: a finished line holding the prompt commits first and the
    // cursor moves to a bare prompt; a message that arrives while a line is still typing
    // waits and follows it
    if (this.current && this.typed < this.current.text.length) {
      this.pending.push(entry);
      return;
    }
    if (this.current) {
      this.log.push(this.current);
      this.current = null;
    }
    this.log.push(entry);
    if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
  }

  /** The typed line is done: anything that waited on it follows it into the log. */
  private flushPending(): void {
    if (!this.pending.length) return;
    if (this.current) {
      this.log.push(this.current);
      this.current = null;
    }
    this.log.push(...this.pending);
    this.pending = [];
    if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
  }

  draw(ctx: CanvasRenderingContext2D, f: SceneFrame): void {
    const { w, h, palette: P } = f;
    const phosphorKey = String(this.settings.phosphor ?? "amber");
    const phosphor: Rgb = P.light
      ? P.ink
      : phosphorKey === "gold"
        ? P.gold
        : phosphorKey === "green"
          ? GREEN
          : AMBER;
    const showStatus = this.settings.status !== false && !f.mini;

    // a new track, or a seek back past the typed line, starts the screen over
    const key = `${f.title ?? ""}|${f.subtitle ?? ""}`;
    const lines = f.lyric?.lines ?? null;
    if (key !== this.trackKey || lines !== this.linesFor) {
      this.trackKey = key;
      this.linesFor = lines;
      this.reset();
    }
    const index = f.lyric?.index ?? -1;
    // a seek either way (back, or forward past lines never typed) rebuilds the log from the
    // track's times, like a remount; a step to the next line is the ordinary case
    if (
      index >= 0 &&
      this.typedIndex >= 0 &&
      (index < this.typedIndex || index > this.typedIndex + 1)
    )
      this.reset();

    // the drums: a kick sags the raster (with a rise, never a pop), a hat flickers the phosphor
    if (f.hitsKnown) {
      for (const hit of f.hits) {
        if (hit.type === "kick") this.sagAim = Math.max(this.sagAim, hit.strength);
        else if (hit.type === "hat")
          this.flicker = Math.max(this.flicker, 0.4 + 0.6 * hit.strength);
      }
    } else if (f.kick > 0.5) this.sagAim = Math.max(this.sagAim, f.kick);
    this.sagAim = easeTowards(this.sagAim, 0, f.dt, 0.12);
    this.sag = easeTowards(this.sag, this.sagAim, f.dt, 0.03);
    this.flicker = easeTowards(this.flicker, 0, f.dt, 0.06);
    this.flash = easeTowards(this.flash, 0, f.dt, 0.5);

    // THE BOOT LOG, for a track without words (and the first lines for any track)
    if (!this.booted) {
      this.booted = true;
      this.push(`TASTYOS v${version}  ready`, null, true);
      if (f.title)
        this.push(`mount "${f.title}"${f.subtitle ? `  ${f.subtitle}` : ""}`, null, true);
    }
    // THE BACKFILL. The scene is rebuilt whenever the view remounts, so the log is rebuilt
    // too, from what the track itself says happened before now: every line already sung, at
    // its time, and every section boundary passed, in time order. One pass, once. Leaving and
    // returning, or seeking back, no longer starts the screen over (the user's ask)
    if (!this.backfilled && lines) {
      this.backfilled = true;
      const events: Array<{ t: number; text: string; sys: boolean }> = [];
      f.sections.forEach((sec, i) => {
        if (i > 0 && sec.start < f.position)
          events.push({
            t: sec.start,
            text: `section ${i + 1}${sec.kind === "chorus" ? "  chorus" : ""}`,
            sys: true,
          });
      });
      lines.forEach((ln, i) => {
        if (ln.text && (index >= 0 ? i < index : ln.t < f.position))
          events.push({ t: ln.t, text: ln.text, sys: false });
      });
      events.sort((a, b) => a.t - b.t);
      for (const e of events) this.log.push({ text: e.text, stamp: stamp(e.t), sys: e.sys });
      if (this.log.length > LOG_MAX) this.log.splice(0, this.log.length - LOG_MAX);
      this.lastSection = f.section ? f.section.index : null;
    }
    if (!this.measured && f.real) {
      const parts: string[] = [];
      if (f.beat && f.beat.confidence >= 0.35) parts.push(`${Math.round(f.beat.bpm)} bpm`);
      if (f.key && f.key.confidence >= 0.3)
        parts.push(`key ${NOTES[f.key.tonic]}${f.key.mode === "minor" ? " minor" : " major"}`);
      if (f.sections.length > 1) parts.push(`${f.sections.length} sections`);
      if (parts.length) {
        this.measured = true;
        // the measure belongs with the boot lines, even when the analysis lands after a backfill
        const at = this.log.findIndex((e) => e.stamp !== "" || !e.sys);
        const entry: Entry = { text: `measure  ${parts.join("  ·  ")}`, stamp: "", sys: true };
        if (at < 0) this.push(entry.text, null, true);
        else this.log.splice(at, 0, entry);
      }
    }
    // the sections and the drops, ticked off as they pass
    const secIndex = f.section ? f.section.index : -1;
    if (secIndex >= 0 && secIndex !== this.lastSection) {
      if (this.lastSection !== null || secIndex > 0)
        this.push(
          `section ${secIndex + 1}${f.section?.kind === "chorus" ? "  chorus" : ""}`,
          f.sections[secIndex]?.start ?? f.position,
          true,
        );
      this.lastSection = secIndex;
    }
    if (f.drop?.onDrop) {
      this.flash = 1;
      this.push("──────────────  drop  ──────────────", f.position, true);
    }

    // THE TYPING. A new line: the unfinished one is completed into the log at once
    if (lines && index >= 0 && index !== this.typedIndex && lines[index]?.text) {
      if (this.current) this.log.push(this.current);
      this.current = null;
      this.flushPending();
      this.current = { text: lines[index].text, stamp: stamp(lines[index].t), sys: false };
      this.typedIndex = index;
      // a line that began more than a moment ago (a remount, a seek) is already typed
      this.typed = f.position - lines[index].t > 1.5 ? lines[index].text.length : 0;
      this.nextKeyAt = f.now + 90;
      this.scroll += 1;
    }
    if (this.current) {
      const text = this.current.text;
      let guard = 0;
      while (this.typed < text.length && f.now >= this.nextKeyAt && guard++ < 40) {
        this.typed++;
        this.nextKeyAt += keyDelay(text[this.typed - 1] ?? "", f.reduced);
      }
      if (this.nextKeyAt < f.now - 500) this.nextKeyAt = f.now;
      if (this.typed >= text.length) this.flushPending();
    }
    this.scroll = easeTowards(this.scroll, 0, f.dt, 0.07);

    // THE SCREEN. Dark, lit a little by the phosphor; on paper, a printout
    ctx.fillStyle = rgb(P.light ? P.bg : mix(P.bg, phosphor, 0.045 + 0.1 * this.flash));
    ctx.fillRect(0, 0, w, h);
    const bodyPx = sceneFont(ctx, f, f.mini ? "small" : "body", 400, { mono: true });
    const rowH = bodyPx * 1.55;
    const margin = Math.round(w * 0.05);
    const sagY = this.sag * 2.5;
    const bright = (1 - 0.1 * this.sag - 0.06 * this.flicker) * (1 + 0.5 * this.flash);
    const glow = !P.light;
    const ink = (alpha: number): string => rgba(phosphor, clamp(alpha * bright));
    if (glow) {
      ctx.shadowColor = rgba(phosphor, 0.55);
      ctx.shadowBlur = bodyPx * (0.35 + 0.6 * this.flash);
    }
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "start";

    // the status line: two rows and a rule
    let top = margin * 0.8 + sagY;
    if (showStatus) {
      const smallPx = sceneFont(ctx, f, "small", 400, { mono: true });
      const sRow = smallPx * 1.6;
      ctx.fillStyle = ink(0.85);
      ctx.fillText(`TASTYOS v${version}`, margin, top + smallPx);
      const head = [f.title, f.subtitle].filter(Boolean).join("  ·  ");
      if (head) {
        ctx.textAlign = "end";
        const room = w - 2 * margin - ctx.measureText(`TASTYOS v${version}    `).width;
        const shown = wrap(ctx, head, room)[0] ?? "";
        ctx.fillText(shown, w - margin, top + smallPx);
        ctx.textAlign = "start";
      }
      const bits: string[] = [];
      bits.push(`${stamp(f.position)}${f.duration ? `/${stamp(f.duration)}` : ""}`);
      if (f.beat && f.beat.confidence >= 0.35) bits.push(`${Math.round(f.beat.bpm)} BPM`);
      if (f.key && f.key.confidence >= 0.3)
        bits.push(`${NOTES[f.key.tonic]}${f.key.mode === "minor" ? "m" : ""}`);
      if (secIndex >= 0)
        bits.push(f.section?.kind === "chorus" ? "CHORUS" : `SECTION ${secIndex + 1}`);
      let meter = "";
      for (let i = 0; i < 6; i++) meter += METER[clamp(Math.floor((f.bands[i] ?? 0) * 7.99), 0, 7)];
      bits.push(meter);
      // the loudness, named for what it is: LOAD read as the machine's CPU (the user's worry)
      bits.push(`LEVEL ${String(Math.round(f.loud * 100)).padStart(3, " ")}%`);
      ctx.fillStyle = ink(0.7);
      ctx.fillText(bits.join("   "), margin, top + sRow + smallPx);
      const ruleY = top + sRow * 2 + smallPx * 0.3;
      ctx.shadowBlur = 0;
      ctx.fillStyle = ink(0.35);
      ctx.fillRect(margin, ruleY, w - 2 * margin, 1);
      if (glow) ctx.shadowBlur = bodyPx * (0.35 + 0.6 * this.flash);
      top = ruleY + rowH * 0.6;
    }

    // the log, bottom up: the line being typed at the foot, the rest above, dimming as they age
    sceneFont(ctx, f, f.mini ? "small" : "body", 400, { mono: true });
    const bottom = h * (f.mini ? 0.92 : 0.88) + sagY;
    const stampW = ctx.measureText("00:00  ").width;
    const textW = w - 2 * margin - stampW;
    const rows = (e: Entry): string[] => wrap(ctx, e.text, textW);
    // the cursor: on the beat, longer on the downbeat; a plain blink without a grid
    const beatPhase = f.beat && f.beat.confidence >= 0.35 ? f.beat.phase : (f.now % 1000) / 1000;
    const cursorOn = f.reduced || beatPhase < (f.beat?.onBar ? 0.7 : 0.55);
    let y = bottom + this.scroll * rowH;
    const entries: Array<{ e: Entry; rows: string[]; typing: boolean }> = [];
    if (this.current) {
      const shown = this.current.text.slice(0, this.typed);
      entries.push({
        e: { ...this.current, text: shown },
        rows: wrap(ctx, shown, textW),
        typing: true,
      });
    } else entries.push({ e: { text: "", stamp: "", sys: false }, rows: [""], typing: true });
    for (
      let i = this.log.length - 1;
      i >= 0 && y - (entries.length + 1) * rowH > top - rowH * 6;
      i--
    )
      entries.push({ e: this.log[i], rows: rows(this.log[i]), typing: false });
    let age = 0;
    for (const { e, rows: rs, typing } of entries) {
      const n = Math.max(1, rs.length);
      const alpha = typing ? 1 : clamp(0.78 - age * 0.06, 0.3, 0.78);
      const baseY = y - (n - 1) * rowH;
      if (baseY < top) break;
      ctx.fillStyle = ink(e.sys ? alpha * 0.7 : alpha);
      // a line without a time (the boot lines, the measure) leaves the stamp column blank: a
      // dim --:-- and a > were both tried and the user preferred the space
      if (e.stamp) ctx.fillText(e.stamp, margin, baseY);
      const x0 = margin + stampW;
      const shownRows = rs.length ? rs : [""];
      shownRows.forEach((r, k) => ctx.fillText(r, x0, baseY + k * rowH));
      if (typing && cursorOn) {
        const last = shownRows[shownRows.length - 1];
        const cx = x0 + ctx.measureText(last).width + bodyPx * 0.15;
        const cy = baseY + (shownRows.length - 1) * rowH;
        ctx.fillStyle = ink(0.95);
        ctx.fillRect(cx, cy - bodyPx * 0.78, bodyPx * 0.55, bodyPx * 0.9);
      }
      y -= n * rowH;
      age++;
    }
    ctx.shadowBlur = 0;
  }
}
