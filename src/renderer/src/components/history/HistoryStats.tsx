import { useEffect, useMemo, useState } from "react";
import { BarChart3 } from "lucide-react";
import { LISTEN_DEFINITION, type ListeningEvent } from "@shared/model";
import { useStore } from "@/store";
import { EmptyState } from "@/components/chrome/EmptyState";
import { Segmented } from "@/components/controls/Segmented";
import { useScrollMemory } from "@/hooks/useScrollMemory";
import { TruncatedPair } from "@/components/media/TruncatedPair";
import { NameLink } from "@/components/media/NameLine";
import { openArtistInLibrary, openRefInLibrary } from "@/lib/mediaActions";
import type { MediaRef } from "@/lib/mediaRef";
import { cx, fmtCount, fmtDuration } from "@/lib/format";
import { FACT_SEP } from "@/lib/mediaFacts";
import { dayStartOf, statsFor, type ListeningStats, type TopEntry } from "@/lib/historyStats";

/**
 * The History screen's STATS (0.8.0, round three): the record as figures for
 * a period — the headline tiles, the trailing year as a calendar, the top
 * albums / artists / tracks, where it played, the files' quality, and the
 * weekday-by-hour grid. Every number comes from lib/historyStats (one home,
 * shared with the Timeline's month dividers and, later, the year card).
 * Form follows the data's job: magnitude is a single hue light to dark, text
 * wears text tokens, bars are thin and directly labeled, every cell has a tip.
 */

type Period = "week" | "month" | "year" | "all";
const PERIOD_LABEL: Record<Period, string> = {
  week: "Past week",
  month: "Past month",
  year: "Past year",
  all: "All time",
};
const PERIOD_MS: Record<Exclude<Period, "all">, number> = {
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
};

/** Session memory: the period comes back as it was left. */
let statsMem: { period: Period } = { period: "month" };

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

export function HistoryStats(): React.JSX.Element {
  const years = useStore((s) => s.history.years);
  const loaded = useStore((s) => s.history.loaded);
  const loadYears = useStore((s) => s.loadHistoryYears);
  const loadYear = useStore((s) => s.loadHistoryYear);
  const recordOn = useStore((s) => s.settings.listeningRecord);
  const scrollRef = useScrollMemory("history:stats");
  const [period, setPeriodState] = useState<Period>(statsMem.period);
  const setPeriod = (p: Period): void => {
    statsMem = { period: p };
    setPeriodState(p);
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
    return out;
  }, [loaded]);
  const range = useMemo(
    () => (period === "all" ? null : { from: now - PERIOD_MS[period], to: now + 1 }),
    [period, now],
  );
  const stats = useMemo(() => statsFor(all, range), [all, range]);
  // the trailing year, always, whatever the period: the calendar is the shape
  // of the year, and the period is the lens on the figures
  const yearStats = useMemo(
    () => statsFor(all, { from: dayStartOf(now) - 364 * 86_400_000, to: now + 1 }),
    [all, now],
  );

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
        <Segmented<Period>
          value={period}
          onChange={setPeriod}
          options={(["week", "month", "year", "all"] as Period[]).map((p) => ({
            value: p,
            label: PERIOD_LABEL[p],
          }))}
        />
        {!allLoaded && <span className="microlabel motion-safe:animate-pulse">reading…</span>}
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
                    <div className="mt-2 px-1 text-[12px] text-faint">
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
  kind: "album" | "artist" | "track" | "station";
  rows: TopEntry[];
}): React.JSX.Element {
  // a station has no Library home: its rows are facts, the others open
  const linked = kind !== "station";
  const open = (r: TopEntry): void => {
    if (kind === "station") return;
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
                  r.sub && kind !== "artist" ? (
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
