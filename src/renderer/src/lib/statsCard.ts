import { fmtCount, fmtDuration } from "@/lib/format";
import { dayStartOf, type ListeningStats, type TopEntry } from "@/lib/historyStats";

/**
 * THE STATS CARD (0.9.0, the listening record's last reading surface, built
 * 2026-09-15 at the user's word as "Your year" and widened the same day at
 * his call to the period the Stats view shows — past week, past month,
 * past year, all time): the view's figures drawn to a canvas and handed
 * back as a PNG. ONE HOME for the numbers: everything here is a
 * ListeningStats from lib/historyStats, the very objects the Stats view
 * renders (the period's figures, and the trailing year for the calendar),
 * so the card can never disagree with the screen. The picture is the
 * screen's grammar at poster size — the four headline tiles, the year at a
 * glance, the most played, where it played, the files, when you listen —
 * in the app's own tokens read from the document at render time (the theme
 * the user is looking at) and its own faces (the display serif for the
 * figures, the sans for the words).
 */
export interface StatsCardInput {
  /** The period's name, as the toggle says it: "Past month", "All time". */
  title: string;
  /** The period's figures (the tiles, the lists, the bars, the week grid). */
  stats: ListeningStats;
  /** The trailing year's figures, for the calendar — the screen's own lens. */
  calendar: ListeningStats;
  /** The clock the calendar ends on. */
  now: number;
  /** The first and last day (dayStart ms) the period covers, for the head. */
  span: { from: number; to: number } | null;
}

/** The card's face: a 4:5 poster, drawn at twice its size for a crisp file. */
const W = 1080;
const H = 1350;
const SCALE = 2;
const M = 72;

interface Tokens {
  bg: string;
  panel: string;
  edge: string;
  ink: string;
  dim: string;
  faint: string;
  gold: [number, number, number];
  inkRgb: [number, number, number];
  display: string;
  sans: string;
  mono: string;
}

const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** The theme's tokens as the document computes them, so the card wears the look on screen. */
function readTokens(): Tokens {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string): string => cs.getPropertyValue(name).trim();
  const goldRaw = v("--gold-rgb").split(/\s+/).map(Number);
  const gold: [number, number, number] =
    goldRaw.length === 3 && goldRaw.every((n) => Number.isFinite(n))
      ? [goldRaw[0], goldRaw[1], goldRaw[2]]
      : [240, 168, 72];
  const ink = v("--color-ink") || "#f4efe6";
  return {
    bg: v("--color-bg") || "#0e0d0b",
    panel: v("--color-panel") || "#151311",
    edge: v("--color-edge") || "rgb(255 255 255 / 0.08)",
    ink,
    dim: v("--color-dim") || "#a69e90",
    faint: v("--color-faint") || "#82786a",
    gold,
    inkRgb: ink.startsWith("#") ? hexToRgb(ink) : [244, 239, 230],
    display: v("--font-display") || '"Fraunces Variable", Georgia, serif',
    sans: v("--font-sans") || '"Instrument Sans Variable", system-ui, sans-serif',
    mono: v("--font-mono") || '"Spline Sans Mono", ui-monospace, monospace',
  };
}

const rgba = (c: [number, number, number], a: number): string =>
  `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

/** The screen's sequential ramp: one hue, five steps of alpha; zero is a whisper of ink. */
function heat(t: Tokens, value: number, max: number): string {
  if (value <= 0 || max <= 0) return rgba(t.inkRgb, 0.05);
  const r = Math.min(1, value / max);
  const step = r < 0.15 ? 0.22 : r < 0.35 ? 0.4 : r < 0.6 ? 0.58 : r < 0.85 ? 0.76 : 0.95;
  return rgba(t.gold, step);
}

/** A line of text cut to a width with an ellipsis. */
function fit(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const hourLabel = (h: number): string =>
  new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" });
const dayLabel = (ms: number, year: boolean): string =>
  new Date(ms).toLocaleDateString(
    undefined,
    year ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" },
  );
/** The span with its year: once at the end when both days share it, on each day otherwise. */
const spanLabel = (from: number, to: number): string =>
  new Date(from).getFullYear() === new Date(to).getFullYear()
    ? `${dayLabel(from, false)} to ${dayLabel(to, true)}`
    : `${dayLabel(from, true)} to ${dayLabel(to, true)}`;

/** Draws the card and resolves to its PNG. */
export async function renderStatsCard(input: StatsCardInput): Promise<Blob> {
  const t = readTokens();
  // the faces must be in before the text is measured, or the fallback serif draws
  await Promise.all([
    document.fonts.load(`600 40px ${t.display}`),
    document.fonts.load(`400 14px ${t.sans}`),
    document.fonts.load(`400 11px ${t.mono}`),
  ]).catch(() => undefined);
  const canvas = document.createElement("canvas");
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.scale(SCALE, SCALE);
  const { stats, calendar, now } = input;
  const micro = (text: string, x: number, y: number): void => {
    ctx.font = `600 11px ${t.sans}`;
    ctx.fillStyle = t.faint;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(text.toUpperCase(), x, y);
  };

  // the ground, and a whisper of gold rising from the foot
  ctx.fillStyle = t.bg;
  ctx.fillRect(0, 0, W, H);
  const wash = ctx.createLinearGradient(0, H * 0.55, 0, H);
  wash.addColorStop(0, rgba(t.gold, 0));
  wash.addColorStop(1, rgba(t.gold, 0.06));
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, W, H);

  // THE HEAD: the period, and what it is
  micro("Your listening in TastyTunes", M, 104);
  ctx.font = `600 92px ${t.display}`;
  ctx.fillStyle = t.ink;
  ctx.fillText(fit(ctx, input.title, W - 2 * M - 260), M - 3, 210);
  if (input.span) {
    ctx.font = `400 15px ${t.sans}`;
    ctx.fillStyle = t.dim;
    ctx.textAlign = "right";
    ctx.fillText(spanLabel(input.span.from, input.span.to), W - M, 210);
    ctx.textAlign = "left";
  }

  // THE TILES: four, the numbers in the display face
  const total = stats.seconds + stats.radioSeconds + stats.externalSeconds;
  const tiles: Array<{ label: string; value: string; sub: string }> = [
    {
      label: "Plays",
      value: fmtCount(stats.plays),
      sub: `${fmtCount(stats.listens)} ${stats.listens === 1 ? "listen" : "listens"}`,
    },
    {
      label: "Listening",
      value: fmtDuration(total, { coarse: true }),
      sub: `${fmtCount(stats.days)} ${stats.days === 1 ? "day" : "days"}`,
    },
    {
      label: "Albums",
      value: fmtCount(stats.albums),
      sub: `${fmtCount(stats.tracks)} ${stats.tracks === 1 ? "track" : "tracks"}`,
    },
    { label: "Artists", value: fmtCount(stats.artists), sub: "from your library" },
  ];
  const gap = 16;
  const tw = (W - 2 * M - 3 * gap) / 4;
  const ty = 262;
  const th = 124;
  tiles.forEach((tile, i) => {
    const x = M + i * (tw + gap);
    roundRect(ctx, x, ty, tw, th, 18);
    ctx.fillStyle = t.panel;
    ctx.fill();
    ctx.strokeStyle = t.edge;
    ctx.lineWidth = 1;
    ctx.stroke();
    micro(tile.label, x + 20, ty + 32);
    ctx.font = `600 38px ${t.display}`;
    ctx.fillStyle = t.ink;
    ctx.fillText(fit(ctx, tile.value, tw - 40), x + 20, ty + 76);
    ctx.font = `400 13px ${t.sans}`;
    ctx.fillStyle = t.faint;
    ctx.fillText(fit(ctx, tile.sub, tw - 40), x + 20, ty + 102);
  });

  // THE YEAR AT A GLANCE: the trailing year as the screen draws it, whatever the period —
  // Monday at the top, a column a week
  const calY = 440;
  micro("The year at a glance", M, calY);
  const yearEnd = dayStartOf(now);
  const yearStart = yearEnd - 364 * 86_400_000;
  const firstDow = (new Date(yearStart).getDay() + 6) % 7;
  const gridStart = yearStart - firstDow * 86_400_000;
  const days: Array<{ day: number; seconds: number; inYear: boolean }> = [];
  for (let d = gridStart; d <= yearEnd; d += 86_400_000) {
    const day = dayStartOf(d);
    days.push({ day, seconds: calendar.byDay.get(day) ?? 0, inYear: day >= yearStart });
  }
  const weeks = Math.ceil(days.length / 7);
  const cgap = 4;
  const cell = Math.floor((W - 2 * M - (weeks - 1) * cgap) / weeks);
  const gridX = M;
  const gridY = calY + 30;
  ctx.font = `400 10px ${t.sans}`;
  ctx.fillStyle = t.faint;
  for (let c = 0; c < weeks; c++) {
    const d = days[c * 7];
    if (!d) continue;
    const date = new Date(d.day);
    if (d.inYear && date.getDate() <= 7)
      ctx.fillText(
        date.toLocaleDateString(undefined, { month: "short" }),
        gridX + c * (cell + cgap),
        gridY - 8,
      );
  }
  const dayMax = Math.max(0, ...days.map((d) => d.seconds));
  days.forEach((d, i) => {
    if (!d.inYear) return;
    const c = Math.floor(i / 7);
    const r = i % 7;
    roundRect(ctx, gridX + c * (cell + cgap), gridY + r * (cell + cgap), cell, cell, 2);
    ctx.fillStyle = heat(t, d.seconds, dayMax);
    ctx.fill();
  });
  const calBottom = gridY + 7 * (cell + cgap);

  // MOST PLAYED: albums, artists, tracks in three columns, five rows each
  const topY = calBottom + 52;
  micro("Most played", M, topY);
  const cols: Array<{ title: string; rows: TopEntry[]; withSub: boolean }> = [
    { title: "Albums", rows: stats.topAlbums.slice(0, 5), withSub: true },
    { title: "Artists", rows: stats.topArtists.slice(0, 5), withSub: false },
    { title: "Tracks", rows: stats.topTracks.slice(0, 5), withSub: true },
  ];
  const colGap = 28;
  const colW = (W - 2 * M - 2 * colGap) / 3;
  const rowH = 42;
  cols.forEach((col, ci) => {
    const x = M + ci * (colW + colGap);
    ctx.font = `400 12.5px ${t.sans}`;
    ctx.fillStyle = t.dim;
    ctx.fillText(col.title, x, topY + 26);
    if (col.rows.length === 0) {
      ctx.font = `400 12px ${t.sans}`;
      ctx.fillStyle = t.faint;
      ctx.fillText("Nothing yet", x, topY + 56);
      return;
    }
    col.rows.forEach((r, i) => {
      const y = topY + 56 + i * rowH;
      ctx.font = `400 10.5px ${t.mono}`;
      ctx.fillStyle = t.faint;
      ctx.fillText(String(i + 1), x, y);
      ctx.font = `500 14.5px ${t.sans}`;
      ctx.fillStyle = t.ink;
      ctx.fillText(fit(ctx, r.name, colW - 22), x + 22, y);
      ctx.font = `400 11.5px ${t.sans}`;
      ctx.fillStyle = t.faint;
      const count = `${fmtCount(r.plays)} ${r.plays === 1 ? "play" : "plays"} · ${fmtDuration(r.seconds)}`;
      const line = col.withSub && r.sub ? `${r.sub} · ${count}` : count;
      ctx.fillText(fit(ctx, line, colW - 22), x + 22, y + 18);
    });
  });
  const topBottom = topY + 56 + 5 * rowH;

  // WHERE IT PLAYED and THE FILES: two columns of bars
  const barsY = topBottom + 10;
  const half = (W - 2 * M - colGap) / 2;
  const drawBars = (
    x: number,
    title: string,
    rows: Array<{ label: string; seconds: number; detail: string | null }>,
  ): void => {
    micro(title, x, barsY);
    const max = Math.max(0, ...rows.map((r) => r.seconds));
    rows.forEach((r, i) => {
      const y = barsY + 30 + i * 30;
      ctx.font = `400 12.5px ${t.sans}`;
      ctx.fillStyle = t.dim;
      ctx.fillText(fit(ctx, r.label, 96), x, y + 4);
      const bx = x + 108;
      const bw = half - 108 - 150;
      roundRect(ctx, bx, y - 4, bw, 8, 4);
      ctx.fillStyle = rgba(t.inkRgb, 0.05);
      ctx.fill();
      const w = max > 0 ? Math.max(bw * 0.01, (r.seconds / max) * bw) : 0;
      if (w > 0) {
        roundRect(ctx, bx, y - 4, w, 8, 4);
        ctx.fillStyle = rgba(t.gold, 0.72);
        ctx.fill();
      }
      ctx.font = `400 11px ${t.sans}`;
      ctx.fillStyle = t.faint;
      ctx.textAlign = "right";
      ctx.fillText(
        fit(
          ctx,
          r.detail ? `${fmtDuration(r.seconds)} · ${r.detail}` : fmtDuration(r.seconds),
          146,
        ),
        x + half,
        y + 4,
      );
      ctx.textAlign = "left";
    });
  };
  drawBars(
    M,
    "Where it played",
    stats.bySource.slice(0, 4).map((s) => ({
      label: s.source,
      seconds: s.seconds,
      detail:
        s.count > 0
          ? `${fmtCount(s.count)} ${s.count === 1 ? s.unit.replace(/^tracks/, "track").replace(/^songs/, "song") : s.unit}`
          : null,
    })),
  );
  const files = [
    { label: "Lossless", seconds: stats.quality.lossless, detail: null },
    { label: "Lossy", seconds: stats.quality.lossy, detail: null },
    { label: "Unknown", seconds: stats.quality.unknown, detail: null },
  ].filter((r) => r.seconds > 0);
  drawBars(M + half + colGap, "The files", files);
  if (stats.quality.hires > 0) {
    ctx.font = `400 11.5px ${t.sans}`;
    ctx.fillStyle = t.faint;
    ctx.fillText(
      `${fmtDuration(stats.quality.hires)} of the lossless time was hi-res.`,
      M + half + colGap,
      barsY + 30 + files.length * 30 + 2,
    );
  }
  const barsBottom = barsY + 30 + 4 * 30;

  // WHEN YOU LISTEN: weekday rows by hour columns, the same ramp
  const weekY = barsBottom + 12;
  micro("When you listen", M, weekY);
  const wcell = 17;
  const wgap = 4;
  const wx = M + 34;
  const wy = weekY + 24;
  const wmax = Math.max(0, ...stats.byWeekdayHour);
  ctx.font = `400 10px ${t.sans}`;
  WEEKDAYS.forEach((w, row) => {
    ctx.fillStyle = t.faint;
    ctx.textBaseline = "middle";
    ctx.fillText(w, M, wy + row * (wcell + wgap) + wcell / 2);
    ctx.textBaseline = "alphabetic";
  });
  stats.byWeekdayHour.forEach((secs, i) => {
    const row = Math.floor(i / 24);
    const hour = i % 24;
    roundRect(ctx, wx + hour * (wcell + wgap), wy + row * (wcell + wgap), wcell, wcell, 2);
    ctx.fillStyle = heat(t, secs, wmax);
    ctx.fill();
  });
  ctx.fillStyle = t.faint;
  for (const h of [0, 6, 12, 18])
    ctx.fillText(hourLabel(h), wx + h * (wcell + wgap), wy + 7 * (wcell + wgap) + 10);

  // THE FOOT: the name, and the record's own limits in a line
  ctx.font = `600 18px ${t.display}`;
  ctx.fillStyle = rgba(t.gold, 0.9);
  ctx.fillText("TastyTunes", M, H - 56);
  ctx.font = `400 11px ${t.sans}`;
  ctx.fillStyle = t.faint;
  ctx.textAlign = "right";
  ctx.fillText(
    "Library tracks count as plays. Radio and other sources count as time.",
    W - M,
    H - 56,
  );
  ctx.textAlign = "left";

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("the card did not encode"))),
      "image/png",
    );
  });
}
