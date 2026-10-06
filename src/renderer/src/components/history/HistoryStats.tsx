import { useEffect, useMemo, useState } from "react";
import { BarChart3, ChevronLeft, ChevronRight, ImageDown } from "lucide-react";
import { LISTEN_DEFINITION, type ListeningEvent } from "@shared/model";
import { useStore } from "@/store";
import { EmptyState } from "@/components/chrome/EmptyState";
import { Segmented } from "@/components/controls/Segmented";
import { Chip } from "@/components/chrome/Chrome";
import { tt } from "@/api";
import { errorMessage } from "@shared/guards";
import { renderStatsCard } from "@/lib/statsCard";
import { useScrollMemory } from "@/hooks/useScrollMemory";
import { TruncatedPair } from "@/components/media/TruncatedPair";
import { NameLink } from "@/components/media/NameLine";
import { openArtistInLibrary, openRefInLibrary } from "@/lib/mediaActions";
import type { MediaRef } from "@/lib/mediaRef";
import { cx, fmtCount, fmtDuration } from "@/lib/format";
import { FACT_SEP } from "@/lib/mediaFacts";
import { dayStartOf, statsFor, type ListeningStats, type TopEntry } from "@/lib/historyStats";
import { narrowToStreamer } from "@/lib/historyStreamers";

/**
 * The History screen's STATS (0.8.0, round three): the record as figures for
 * a period — the headline tiles, the trailing year as a calendar, the top
 * albums / artists / tracks, where it played, the files' quality, and the
 * weekday-by-hour grid. Every number comes from lib/historyStats (one home,
 * shared with the Timeline's month dividers and, later, the year card).
 * Form follows the data's job: magnitude is a single hue light to dark, text
 * wears text tokens, bars are thin and directly labeled, every cell has a tip.
 */

/** THE PERIOD IS A CALENDAR INSTANCE (2026-09-15, the user: people expect "the previous
 *  full instance of whatever period they asked for"): a unit — a week from Monday, a month
 *  from the first, a year from January — and how many instances back from the one holding
 *  now. Zero is the current instance so far; one is the last full week or month; the arrows
 *  beside the toggle step. All time has no instances. The rolling windows this replaced (the
 *  last seven days as of this minute) promised a week and never had a Monday. */
type Unit = "week" | "month" | "year" | "all";
type Span = { from: number; to: number };
const UNIT_LABEL: Record<Unit, string> = {
  week: "Week",
  month: "Month",
  year: "Year",
  all: "All time",
};
const DAY_MS = 86_400_000;

/** The instance `back` steps before the one holding `now`: its start, and the next one's.
 *  By the calendar's own setters, so a week across a clock change still starts at midnight. */
function instanceOf(unit: Exclude<Unit, "all">, now: number, back: number): Span {
  const s = new Date(now);
  s.setHours(0, 0, 0, 0);
  if (unit === "week") s.setDate(s.getDate() - ((s.getDay() + 6) % 7) - back * 7);
  else if (unit === "month") {
    s.setDate(1);
    s.setMonth(s.getMonth() - back);
  } else {
    s.setMonth(0, 1);
    s.setFullYear(s.getFullYear() - back);
  }
  const e = new Date(s);
  if (unit === "week") e.setDate(e.getDate() + 7);
  else if (unit === "month") e.setMonth(e.getMonth() + 1);
  else e.setFullYear(e.getFullYear() + 1);
  return { from: s.getTime(), to: e.getTime() };
}

/** What an instance is called: "This week" for the one holding now, else its own name — a
 *  week by its Monday ("Week of Sep 7", the card's span saying the rest), a month by name, a
 *  year by number; the year spelled out once a week is not this year's. */
function instanceLabel(unit: Exclude<Unit, "all">, inst: Span, back: number, now: number): string {
  if (back === 0)
    return unit === "week" ? "This week" : unit === "month" ? "This month" : "This year";
  const from = new Date(inst.from);
  if (unit === "year") return String(from.getFullYear());
  if (unit === "month")
    return from.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const thisYear = from.getFullYear() === new Date(now).getFullYear();
  return `Week of ${from.toLocaleDateString(
    undefined,
    thisYear
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
  )}`;
}

/** The file a saved image takes: the instance by its calendar name. */
function instanceFile(unit: Unit, inst: Span | null): string {
  if (unit === "all" || !inst) return "tastytunes-all-time.png";
  const d = new Date(inst.from);
  const y = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return unit === "year"
    ? `tastytunes-${y}.png`
    : unit === "month"
      ? `tastytunes-${y}-${mm}.png`
      : `tastytunes-week-${y}-${mm}-${dd}.png`;
}

/** Session memory: the unit and the instance come back as they were left. */
let statsMem: { unit: Unit; back: number } = { unit: "month", back: 0 };

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The sequential ramp: ONE hue (gold), light to dark, five steps of alpha on
 *  the ground; zero is the ground with a whisper of edge. */
function heat(value: number, max: number): string {
  if (value <= 0 || max <= 0) return "color-mix(in oklab, var(--color-ink) 5%, transparent)";
  const t = Math.min(1, value / max);
  const step = t < 0.15 ? 0.22 : t < 0.35 ? 0.4 : t < 0.6 ? 0.58 : t < 0.85 ? 0.76 : 0.95;
  return `color-mix(in oklab, var(--color-gold) ${Math.round(step * 100)}%, transparent)`;
}

const hourLabel = (h: number): string =>
  new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" });

export function HistoryStats({
  streamer,
}: {
  /** The rail's streamer facet (lib/historyStreamers): null is every streamer. */
  streamer: string | null;
}): React.JSX.Element {
  const years = useStore((s) => s.history.years);
  const loaded = useStore((s) => s.history.loaded);
  const loadYears = useStore((s) => s.loadHistoryYears);
  const loadYear = useStore((s) => s.loadHistoryYear);
  const recordOn = useStore((s) => s.settings.listeningRecord);
  const scrollRef = useScrollMemory("history:stats");
  const [unit, setUnitState] = useState<Unit>(statsMem.unit);
  const [back, setBackState] = useState(statsMem.back);
  const setUnit = (u: Unit): void => {
    statsMem = { unit: u, back: 0 };
    setUnitState(u);
    setBackState(0);
  };
  const setBack = (b: number): void => {
    statsMem = { unit, back: b };
    setBackState(b);
  };
  // figures want the whole record: every year, loaded once
  useEffect(() => {
    if (years == null) void loadYears();
    else for (const y of years) if (loaded[y] == null) void loadYear(y);
  }, [years, loaded, loadYears, loadYear]);
  const allLoaded = years != null && years.every((y) => loaded[y] != null);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const all = useMemo(() => {
    const out: ListeningEvent[] = [];
    for (const y of Object.keys(loaded)
      .map(Number)
      .sort((a, b) => a - b))
      out.push(...(loaded[y] ?? []));
    return narrowToStreamer(out, streamer);
  }, [loaded, streamer]);
  const inst = useMemo(
    () => (unit === "all" ? null : instanceOf(unit, now, back)),
    [unit, now, back],
  );
  const stats = useMemo(() => statsFor(all, inst), [all, inst]);
  // the record's first moment: the arrows stop where the record does
  const first = useMemo(() => {
    let f: number | null = null;
    for (const e of all) if (f == null || e.at < f) f = e.at;
    return f;
  }, [all]);
  const canBack = inst != null && first != null && inst.from > first;
  const canForward = back > 0;
  // two streamers' slots can share a name: only then does a preset row name its streamer,
  // from the device book first (remembered streamers) and live discovery second
  const knownDevices = useStore((st) => st.settings.knownDevices);
  const devices = useStore((st) => st.devices);
  const topPresets = useMemo(() => {
    const names = new Map<string, number>();
    for (const r of stats.topPresets) names.set(r.name, (names.get(r.name) ?? 0) + 1);
    if (![...names.values()].some((n) => n > 1)) return stats.topPresets;
    const streamerName = (udn: string | null | undefined): string =>
      (udn &&
        (knownDevices.find((d) => d.udn === udn)?.friendlyName ??
          devices.find((d) => d.udn === udn)?.friendlyName)) ||
      "another streamer";
    return stats.topPresets.map((r) =>
      (names.get(r.name) ?? 0) > 1 ? { ...r, sub: streamerName(r.streamer) } : r,
    );
  }, [stats.topPresets, knownDevices, devices]);
  // the trailing year, always, whatever the period: the calendar is the shape
  // of the year, and the period is the lens on the figures
  const yearStats = useMemo(
    () => statsFor(all, { from: dayStartOf(now) - 364 * 86_400_000, to: now + 1 }),
    [all, now],
  );
  // THE PICTURE (0.9.0): the period shown, drawn to a canvas and saved as a PNG — lib/statsCard,
  // the same ListeningStats the tiles read and the same trailing year the calendar draws, so
  // the card and the screen agree; built as "Your year" (the calendar year) and widened at
  // the user's call to whatever the toggle shows (2026-09-15)
  const showToast = useStore((s) => s.showToast);
  const [cardBusy, setCardBusy] = useState(false);
  const saveCard = async (): Promise<void> => {
    setCardBusy(true);
    try {
      const today = dayStartOf(now);
      const label = unit === "all" || !inst ? "All time" : instanceLabel(unit, inst, back, now);
      const span =
        unit === "all" || !inst
          ? first != null
            ? { from: dayStartOf(first), to: today }
            : null
          : { from: inst.from, to: Math.min(inst.to - DAY_MS, today) };
      const png = await renderStatsCard({ title: label, stats, calendar: yearStats, now, span });
      const bytes = new Uint8Array(await png.arrayBuffer());
      const name = instanceFile(unit, inst);
      const saved = await tt.statsCardSave(bytes, name);
      if (saved) showToast({ kind: "success", text: `Saved as ${saved.file}` });
    } catch (e) {
      showToast({ kind: "error", text: `Couldn't save the picture: ${errorMessage(e)}` });
    } finally {
      setCardBusy(false);
    }
  };

  if (years != null && years.length === 0) {
    return (
      <EmptyState
        icon={BarChart3}
        title="No listening recorded yet"
        caption={
          recordOn
            ? "Figures appear once the record has plays in it."
            : "The listening record is off. Turn it on in Settings › History and the figures will follow."
        }
      />
    );
  }

  const total = stats.seconds + stats.radioSeconds + stats.externalSeconds;
  const empty = stats.plays === 0 && total === 0;

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 pb-3 px-1 flex-wrap" data-history-stats-toolbar>
        <Segmented<Unit>
          value={unit}
          onChange={setUnit}
          options={(["week", "month", "year", "all"] as Unit[]).map((u) => ({
            value: u,
            label: UNIT_LABEL[u],
          }))}
        />
        {unit !== "all" && inst && (
          <div className="flex items-center gap-0.5" data-stats-stepper>
            <button
              type="button"
              data-stats-step="back"
              aria-label={`The previous ${unit}`}
              disabled={!canBack}
              onClick={() => setBack(back + 1)}
              className="h-8 w-8 rounded-full flex items-center justify-center text-dim hover:text-ink hover:bg-veil disabled:opacity-40 disabled:pointer-events-none"
            >
              <ChevronLeft size={14} />
            </button>
            <span
              data-stats-instance
              className="min-w-[7.5rem] text-center text-[12.5px] text-dim tabular-nums"
            >
              {instanceLabel(unit, inst, back, now)}
            </span>
            <button
              type="button"
              data-stats-step="forward"
              aria-label={`The next ${unit}`}
              disabled={!canForward}
              onClick={() => setBack(back - 1)}
              className="h-8 w-8 rounded-full flex items-center justify-center text-dim hover:text-ink hover:bg-veil disabled:opacity-40 disabled:pointer-events-none"
            >
              <ChevronRight size={14} />
            </button>
          </div>
        )}
        {!allLoaded && <span className="microlabel motion-safe:animate-pulse">reading…</span>}
        <Chip
          data-stats-card
          state={!empty && !cardBusy ? "idle" : "disabled"}
          disabled={empty || cardBusy}
          onClick={() => void saveCard()}
          className="ml-auto gap-1.5"
          title="Save this period as an image"
        >
          <ImageDown size={14} />
          {cardBusy ? "Drawing…" : "Save image"}
        </Chip>
      </div>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-1 pb-8" data-history-stats>
        <div className="max-w-3xl space-y-8">
          {empty ? (
            <div className="text-[15px] text-faint pt-6 px-1">Nothing in this period.</div>
          ) : (
            <>
              {/* the headline: four tiles, numbers in ink */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" data-stats-tiles>
                <Tile
                  label="Plays"
                  value={fmtCount(stats.plays)}
                  sub={`${fmtCount(stats.listens)} ${stats.listens === 1 ? "listen" : "listens"}`}
                  subTip={LISTEN_DEFINITION}
                />
                <Tile
                  label="Listening"
                  value={fmtDuration(total, { coarse: true })}
                  sub={`${fmtCount(stats.days)} ${stats.days === 1 ? "day" : "days"}`}
                />
                <Tile
                  label="Albums"
                  value={fmtCount(stats.albums)}
                  sub={`${fmtCount(stats.tracks)} ${stats.tracks === 1 ? "track" : "tracks"}`}
                />
                <Tile label="Artists" value={fmtCount(stats.artists)} sub="from your library" />
              </div>
            </>
          )}

          <Calendar stats={yearStats} now={now} />

          {!empty && (
            <>
              <section data-stats-top>
                <div className="microlabel mb-3 px-1">Most played</div>
                {/* stacked, full width: three columns cropped every second title
                    (user, 2026-09-05); a name is the point of a top list */}
                <div className="space-y-6">
                  <TopList title="Albums" kind="album" rows={stats.topAlbums} />
                  <TopList title="Artists" kind="artist" rows={stats.topArtists} />
                  <TopList title="Tracks" kind="track" rows={stats.topTracks} />
                  {stats.topStations.length > 0 && (
                    <TopList title="Stations" kind="station" rows={stats.topStations} />
                  )}
                  {topPresets.length > 0 && (
                    <TopList title="Presets" kind="preset" rows={topPresets} />
                  )}
                  {stats.topPlaylists.length > 0 && (
                    <TopList title="Playlists" kind="playlist" rows={stats.topPlaylists} />
                  )}
                </div>
              </section>

              <section data-stats-sources>
                <div className="microlabel mb-3 px-1">Where it played</div>
                <Bars
                  rows={stats.bySource.map((s) => ({
                    label: s.source,
                    seconds: s.seconds,
                    detail:
                      s.count > 0
                        ? `${fmtCount(s.count)} ${s.count === 1 ? s.unit.replace(/^tracks/, "track").replace(/^songs/, "song") : s.unit}`
                        : null,
                  }))}
                />
              </section>

              {stats.viaSeen && (
                <section data-stats-started>
                  <div className="microlabel mb-3 px-1">Started from</div>
                  <Bars
                    rows={stats.startedFrom
                      .filter((r) => r.seconds > 0)
                      .map((r) => ({
                        label: r.label,
                        seconds: r.seconds,
                        detail:
                          r.count > 0
                            ? `${fmtCount(r.count)} ${r.count === 1 ? "play" : "plays"}`
                            : null,
                      }))}
                  />
                  <div data-stats-started-note className="mt-3 px-1 text-[12px] text-faint/70">
                    Only what TastyTunes itself started is known. A preset pressed on the streamer,
                    or a queue another app built, counts as elsewhere.
                  </div>
                </section>
              )}

              {stats.seconds > 0 && (
                <section data-stats-quality>
                  <div className="microlabel mb-3 px-1">The files</div>
                  <Bars
                    rows={[
                      { label: "Lossless", seconds: stats.quality.lossless },
                      { label: "Lossy", seconds: stats.quality.lossy },
                      { label: "Unknown", seconds: stats.quality.unknown },
                    ].filter((r) => r.seconds > 0)}
                  />
                  {stats.quality.hires > 0 && (
                    <div className="mt-3 px-1 text-[12px] text-faint/70">
                      {fmtDuration(stats.quality.hires)} of the lossless time was hi-res.
                    </div>
                  )}
                </section>
              )}

              <WeekGrid stats={stats} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  subTip,
}: {
  label: string;
  value: string;
  sub: string | null;
  /** A definition behind the sub-line, on hover (the listen rule). */
  subTip?: string;
}): React.JSX.Element {
  return (
    <div className="rounded-xl ring-1 ring-edge bg-panel/60 px-4 py-3" data-stats-tile={label}>
      <div className="microlabel">{label}</div>
      <div className="mt-1 font-display text-[24px] leading-tight text-ink tabular-nums">
        {value}
      </div>
      {sub && (
        <div
          className={cx("mt-0.5 text-[11.5px] text-faint", subTip && "tip-bottom tip-wide w-fit")}
          data-tip={subTip}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

/** The trailing year as a heatmap: 53 columns of weeks, Monday at the top.
 *  Magnitude is minutes listened; one hue, light to dark; a tip on every day. */
function Calendar({ stats, now }: { stats: ListeningStats; now: number }): React.JSX.Element {
  const days = useMemo(() => {
    const end = dayStartOf(now);
    const start = end - 364 * 86_400_000;
    // the first column begins on the Monday on or before the first day
    const firstDow = (new Date(start).getDay() + 6) % 7;
    const gridStart = start - firstDow * 86_400_000;
    const out: Array<{ day: number; seconds: number; inRange: boolean }> = [];
    for (let d = gridStart; d <= end; d += 86_400_000) {
      const day = dayStartOf(d);
      out.push({ day, seconds: stats.byDay.get(day) ?? 0, inRange: day >= start });
    }
    return out;
  }, [stats, now]);
  const max = useMemo(() => Math.max(0, ...days.map((d) => d.seconds)), [days]);
  const weeks = Math.ceil(days.length / 7);
  // month labels above the column where a month begins
  const monthLabels: Array<{ col: number; label: string }> = [];
  for (let c = 0; c < weeks; c++) {
    const d = days[c * 7];
    if (!d) continue;
    const date = new Date(d.day);
    if (date.getDate() <= 7)
      monthLabels.push({ col: c, label: date.toLocaleDateString(undefined, { month: "short" }) });
  }
  const dayTip = (d: { day: number; seconds: number }): string =>
    `${new Date(d.day).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}${FACT_SEP}${d.seconds > 0 ? fmtDuration(d.seconds) : "nothing"}`;
  return (
    <section data-stats-calendar>
      <div className="microlabel mb-3 px-1">The year at a glance</div>
      <div className="px-1">
        <div
          className="relative grid gap-[3px]"
          style={{ gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))`, gridAutoRows: "auto" }}
        >
          {monthLabels.map((m) => (
            <div
              key={`${m.col}-${m.label}`}
              className="h-3 text-[9px] text-faint leading-none whitespace-nowrap"
              style={{ gridColumn: m.col + 1, gridRow: 1 }}
            >
              {m.label}
            </div>
          ))}
          {days.map((d, i) => (
            <div
              key={d.day}
              data-stats-day={d.day}
              data-tip={d.inRange ? dayTip(d) : undefined}
              className={cx("aspect-square rounded-[2px]", d.inRange ? "tip-bottom" : "opacity-0")}
              style={{
                gridColumn: Math.floor(i / 7) + 1,
                gridRow: (i % 7) + 2,
                background: heat(d.seconds, max),
              }}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

/** A top-list entry as a Library ref: content identity only, the Library resolves it. */
const refOf = (kind: "album" | "track", r: TopEntry): MediaRef => ({
  kind,
  title: r.name,
  artist: r.sub,
  album: r.album,
  artUrl: null,
  durationSecs: null,
  url: null,
  serverUdn: null,
  serverName: null,
  objectId: null,
});

/** The rows are LINKS into the Library (user, 2026-09-05): an album lands on
 *  itself, an artist on the Artists lens, a track on its album with the row
 *  flashed — the app-wide Open in Library, by content. The artist beside an
 *  album or a track is its own link (NameLink, the one link primitive). */
function TopList({
  title,
  kind,
  rows,
}: {
  title: string;
  kind: "album" | "artist" | "track" | "station" | "preset" | "playlist";
  rows: TopEntry[];
}): React.JSX.Element {
  // a station, a preset or a playlist has no Library home: its rows are facts, the others open
  const linked = kind !== "station" && kind !== "preset" && kind !== "playlist";
  const open = (r: TopEntry): void => {
    if (!linked) return;
    if (kind === "artist") openArtistInLibrary(r.name);
    else void openRefInLibrary(refOf(kind, r));
  };
  return (
    <div data-stats-list={title}>
      <div className="text-[12.5px] text-dim mb-1.5 px-1">{title}</div>
      {rows.length === 0 ? (
        <div className="px-1 text-[12px] text-faint">Nothing yet</div>
      ) : (
        <ol className="space-y-0.5">
          {rows.map((r, i) => (
            <li
              key={`${r.name}-${i}`}
              role={linked ? "button" : undefined}
              tabIndex={linked ? 0 : undefined}
              data-stats-open={kind}
              data-tip={linked ? "Open in Library" : undefined}
              onClick={linked ? () => open(r) : undefined}
              onKeyDown={
                linked
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        open(r);
                      }
                    }
                  : undefined
              }
              className={cx(
                "flex items-baseline gap-3 rounded-lg px-1 py-1 transition-colors",
                linked && "tip-bottom tip-start cursor-pointer hover:bg-veil",
              )}
            >
              <span className="w-4 shrink-0 font-mono text-[10.5px] text-faint tabular-nums">
                {i + 1}
              </span>
              <TruncatedPair
                className="flex-1 text-[13px]"
                lead={r.name}
                leadClass="text-ink"
                sub={
                  r.sub && (kind === "preset" || kind === "playlist") ? (
                    <span>{r.sub}</span>
                  ) : r.sub && kind !== "artist" ? (
                    <NameLink
                      kind="artist"
                      name={r.sub}
                      className="hover:text-ink hover:underline underline-offset-2"
                    >
                      {r.sub}
                    </NameLink>
                  ) : null
                }
                subClass="text-dim"
                sep={FACT_SEP}
              />
              <span className="shrink-0 text-[11px] text-faint tabular-nums">
                {kind === "station"
                  ? `${fmtDuration(r.seconds)}${r.plays > 0 ? `${FACT_SEP}${fmtCount(r.plays)} ${r.plays === 1 ? "song" : "songs"} heard` : ""}`
                  : r.plays === 0
                    ? fmtDuration(r.seconds) // a station preset: time heard, no plays to count
                    : `${fmtCount(r.plays)} ${r.plays === 1 ? "play" : "plays"}${FACT_SEP}${fmtDuration(r.seconds)}`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Horizontal bars, one series: thin, rounded at the data end, directly
 *  labeled with the value — no legend for a single series. */
function Bars({
  rows,
}: {
  rows: Array<{ label: string; seconds: number; detail?: string | null }>;
}): React.JSX.Element {
  const max = Math.max(0, ...rows.map((r) => r.seconds));
  return (
    <div className="space-y-2 px-1">
      {rows.map((r) => (
        <div key={r.label} className="flex items-center gap-3" data-stats-bar={r.label}>
          <span className="w-28 shrink-0 truncate text-[12.5px] text-dim">{r.label}</span>
          <div className="flex-1 h-2 rounded-full bg-ink/5">
            <div
              className="h-2 rounded-full"
              style={{
                width: `${max > 0 ? Math.max(1, (r.seconds / max) * 100) : 0}%`,
                background: "color-mix(in oklab, var(--color-gold) 72%, transparent)",
              }}
            />
          </div>
          <span className="w-44 shrink-0 text-right text-[11.5px] text-faint tabular-nums">
            {r.detail ? `${fmtDuration(r.seconds)}${FACT_SEP}${r.detail}` : fmtDuration(r.seconds)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** When you listen: weekday rows by hour columns, the same ramp as the calendar. */
function WeekGrid({ stats }: { stats: ListeningStats }): React.JSX.Element {
  const max = Math.max(0, ...stats.byWeekdayHour);
  return (
    <section data-stats-week>
      <div className="microlabel mb-3 px-1">When you listen</div>
      <div className="px-1">
        <div
          className="grid gap-[3px] max-w-lg"
          style={{ gridTemplateColumns: "28px repeat(24, minmax(0, 1fr))", gridAutoRows: "auto" }}
        >
          {WEEKDAYS.map((w, row) => (
            <div
              key={w}
              className="flex items-center text-[9px] text-faint leading-none"
              style={{ gridColumn: 1, gridRow: row + 1 }}
            >
              {w}
            </div>
          ))}
          {stats.byWeekdayHour.map((secs, i) => {
            const row = Math.floor(i / 24);
            const hour = i % 24;
            return (
              <div
                key={i}
                data-stats-cell={`${row}-${hour}`}
                data-tip={`${WEEKDAYS[row]} ${hourLabel(hour)}${FACT_SEP}${secs > 0 ? fmtDuration(secs) : "nothing"}`}
                className="tip-bottom aspect-square rounded-[2px]"
                style={{ gridColumn: hour + 2, gridRow: row + 1, background: heat(secs, max) }}
              />
            );
          })}
          {[0, 6, 12, 18].map((h) => (
            <div
              key={h}
              className="h-3 whitespace-nowrap text-[9px] text-faint leading-none"
              style={{ gridColumn: h + 2, gridRow: 8 }}
            >
              {hourLabel(h)}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
