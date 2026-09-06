import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Clock, MoreHorizontal, Play } from "lucide-react";
import {
  groupSessions,
  type ListeningEvent,
  type ListeningPlayEvent,
  type ListeningSession,
  isListen,
  LISTEN_DEFINITION,
  playKey,
} from "@shared/model";
import { useStore } from "@/store";
import { Chip } from "@/components/chrome/Chrome";
import { EmptyState } from "@/components/chrome/EmptyState";
import { PickerPill } from "@/components/controls/PickerPill";
import { Segmented } from "@/components/controls/Segmented";
import { MediaRow } from "@/components/media/MediaRow";
import { NameLine } from "@/components/media/NameLine";
import { RowAction } from "@/components/media/RowAction";
import { RowMenu } from "@/components/media/RowMenu";
import { useOneShotAsk } from "@/hooks/useOneShotAsk";
import { useScrollMemory } from "@/hooks/useScrollMemory";
import { useWindowedList } from "@/hooks/useWindowedList";
import { useArtByKeys } from "@/lib/artByKey";
import { fromPlayEvent } from "@/lib/mediaRef";
import { openRefInLibrary, playRefNow } from "@/lib/mediaActions";
import { trackMenuItems, type MediaMenuItem } from "@/lib/mediaMenus";
import { cx, fmtCount, fmtDuration, fmtTime, matchesFilter } from "@/lib/format";
import { FACT_SEP } from "@/lib/mediaFacts";
import { monthLine, monthStartOf, statsFor } from "@/lib/historyStats";

/**
 * The History screen's TIMELINE (0.8.0, rounds two and 2b): the whole
 * listening record as a log, newest first — days, the SESSIONS within a day
 * (SESSION_GAP_MS apart, every kind together), and the lines within a session
 * as rows: a library play with what it heard of the track, a station's
 * announced song, an external source's track.
 *
 * At scale (a year or three is ~20,000 plays) the unit is the SESSION: each
 * collapses to its head line and opens on click; "Every play" keeps the full
 * log one click away. A month rail lands the list by index, a floating date
 * says where you are, and three facets narrow it (Source, Period, Listens
 * only) beside the header's text filter — any of which loads every year, not
 * only the newest. The album header's "last played" fact lands here on its
 * play (store.historyJump). The record is read a YEAR at a time (its files
 * are per year); three row heights, one windowed list (useWindowedList).
 */

type Item =
  | { kind: "month"; key: string; month: number; line: string | null }
  | { kind: "day"; key: string; day: number }
  | { kind: "session"; key: string; session: ListeningSession; open: boolean }
  | { kind: "play"; key: string; event: ListeningEvent; session: ListeningSession };

const ITEM_ESTIMATE = { month: 44, day: 34, session: 46, play: 61 };
const WINDOW_ABOVE = 200;
const FLASH_MS = 1800;

/** The facets: session memory, like the lenses' — back as they were left. */
let timelineMem: { source: string | null; period: string | null; listensOnly: boolean } = {
  source: null,
  period: null,
  listensOnly: false,
};
/** The open set too (2026-09-05): coming back from an artist finds the session
 *  still open under the remembered scroll spot. Kept with the mode it belongs
 *  to, since the set means "open" in Sessions and "closed" in Every play. */
let toggledMem: { mode: string; keys: ReadonlySet<string> } = { mode: "sessions", keys: new Set() };

const dayStart = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** The day header: Today, Yesterday, a weekday within the week, then the
 *  date (with its year once it is not this year's). */
function dayLabel(at: number, now: number): string {
  const days = Math.round((dayStart(now) - dayStart(at)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(at);
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  const thisYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(thisYear ? {} : { year: "numeric" }),
  });
}

const timeOf = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

const eventText = (e: ListeningEvent): Array<string | null> => {
  switch (e.kind) {
    case "play":
      return [e.title, e.artist, e.album, e.source];
    case "external":
      return [e.title, e.artist, e.album, e.source];
    case "radio-session":
      return [e.station];
    case "radio-track":
      return [e.title, e.artist, e.station];
    default:
      return [];
  }
};

/** The Source facet's value for a line: the library, the radio, or an
 *  external source by its name. */
const sourceOf = (e: ListeningEvent): string =>
  e.kind === "play" ? "library" : e.kind === "external" ? `ext:${e.source ?? "other"}` : "radio";
const sourceLabel = (v: string): string =>
  v === "library" ? "Library" : v === "radio" ? "Radio" : v.slice(4);

const PERIODS: Array<{ value: string; label: string; ms: number }> = [
  { value: "week", label: "Past week", ms: 7 * 86_400_000 },
  { value: "month", label: "Past month", ms: 30 * 86_400_000 },
  { value: "year", label: "Past year", ms: 365 * 86_400_000 },
];

/** A line a "Listens only" view keeps: a play heard to the house definition
 *  (partials go), an external track by the same rule; radio lines stay. */
const listenLine = (e: ListeningEvent): boolean =>
  e.kind === "play" || e.kind === "external" ? isListen(e.playedSeconds, e.duration) : true;

/** What a session was, in one line: "12 tracks · Amber Nights, Neon Evenings
 *  · Media Library", "KEXP · radio · 14 songs heard", "AirPlay · 6 tracks". */
function sessionSummary(s: ListeningSession): string {
  const parts: string[] = [];
  const plays = s.events.filter((e): e is ListeningPlayEvent => e.kind === "play");
  if (plays.length > 0) {
    parts.push(`${plays.length} ${plays.length === 1 ? "track" : "tracks"}`);
    const albums = [...new Set(plays.map((p) => p.album).filter((a): a is string => !!a))];
    if (albums.length > 0)
      parts.push(
        albums.length <= 2
          ? albums.join(", ")
          : `${albums.slice(0, 2).join(", ")} and ${albums.length - 2} more`,
      );
    const sources = [...new Set(plays.map((p) => p.source).filter((x): x is string => !!x))];
    if (sources.length === 1) parts.push(sources[0]);
  }
  const radio = s.events.filter((e) => e.kind === "radio-session");
  if (radio.length > 0) {
    const stations = [
      ...new Set(
        radio
          .map((r) => (r.kind === "radio-session" ? r.station : null))
          .filter((x): x is string => !!x),
      ),
    ];
    parts.push(stations.length > 0 ? stations.join(", ") : "radio");
    const songs = s.events.filter((e) => e.kind === "radio-track").length;
    if (songs > 0) parts.push(`${songs} ${songs === 1 ? "song" : "songs"} heard`);
  }
  const ext = s.events.filter((e) => e.kind === "external");
  if (ext.length > 0) {
    const sources = [
      ...new Set(
        ext.map((x) => (x.kind === "external" ? x.source : null)).filter((x): x is string => !!x),
      ),
    ];
    parts.push(
      `${sources.length > 0 ? sources.join(", ") : "another source"}${FACT_SEP}${ext.length} ${ext.length === 1 ? "track" : "tracks"}`,
    );
  }
  // the album facts line's separator (lib/mediaFacts): one register for facts
  return parts.join(FACT_SEP);
}

/** The header's filter over record lines: title, artist, album, station, source. */
export function filterEvents(events: readonly ListeningEvent[], filter: string): ListeningEvent[] {
  return events.filter((e) => matchesFilter(filter, eventText(e)));
}

const sessionKey = (s: ListeningSession): string => `s${s.startAt}`;
const MONTH_LABEL = (m: number): string =>
  new Date(2000, m, 1).toLocaleDateString(undefined, { month: "short" });

export function HistoryTimeline({ filter }: { filter: string }): React.JSX.Element {
  const years = useStore((s) => s.history.years);
  const loaded = useStore((s) => s.history.loaded);
  const loadYears = useStore((s) => s.loadHistoryYears);
  const loadYear = useStore((s) => s.loadHistoryYear);
  const recordOn = useStore((s) => s.settings.listeningRecord);
  const mode = useStore((s) => s.settings.historyTimelineMode);
  const saveSettings = useStore((s) => s.saveSettings);
  const historyJump = useStore((s) => s.historyJump);
  const clearHistoryJump = useStore((s) => s.clearHistoryJump);
  const [mem, setMemState] = useState(timelineMem);
  const setMem = (patch: Partial<typeof timelineMem>): void => {
    timelineMem = { ...timelineMem, ...patch };
    setMemState(timelineMem);
  };

  useEffect(() => {
    if (years == null) void loadYears();
  }, [years, loadYears]);
  // the newest year first; the years before wait for "Show <year>" — unless a
  // filter or a facet is on, which means the whole record, not the loaded part
  const newest = years && years.length > 0 ? years[years.length - 1] : null;
  const needAll = filter !== "" || mem.source != null || mem.period != null || mem.listensOnly;
  useEffect(() => {
    if (newest != null && loaded[newest] == null) void loadYear(newest);
    if (needAll && years) for (const y of years) if (loaded[y] == null) void loadYear(y);
  }, [newest, loaded, loadYear, needAll, years]);
  // a jump into a year not loaded yet loads it first
  useEffect(() => {
    if (historyJump && years) {
      const y = new Date(historyJump.at).getFullYear();
      if (years.includes(y) && loaded[y] == null) void loadYear(y);
    }
  }, [historyJump, years, loaded, loadYear]);
  const loadedYears = useMemo(
    () =>
      Object.keys(loaded)
        .map(Number)
        .sort((a, b) => b - a),
    [loaded],
  );
  const earlier = years?.filter((y) => loaded[y] == null && (newest == null || y < newest)) ?? [];
  const nextEarlier = earlier.length > 0 ? earlier[earlier.length - 1] : null;

  // the clock, for the day labels (render time only: the grouping never
  // depends on it, so a minute's tick costs nothing at tens of thousands of lines)
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const all = useMemo(() => {
    const out: ListeningEvent[] = [];
    for (const y of loadedYears) out.push(...(loaded[y] ?? []));
    return out;
  }, [loaded, loadedYears]);
  const textShown = useMemo(() => (filter ? filterEvents(all, filter) : all), [all, filter]);
  // the facets' options, count-carrying, from the text-narrowed pool
  const sourceOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of textShown) counts.set(sourceOf(e), (counts.get(sourceOf(e)) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([value, count]) => ({ value, label: sourceLabel(value), count }));
  }, [textShown]);
  const periodOptions = useMemo(
    () =>
      PERIODS.map((p) => ({
        value: p.value,
        label: p.label,
        count: textShown.filter((e) => e.at >= now - p.ms).length,
      })).filter((o) => o.count > 0 && o.count < textShown.length),
    [textShown, now],
  );
  const shown = useMemo(() => {
    let list = textShown;
    if (mem.source) list = list.filter((e) => sourceOf(e) === mem.source);
    const period = PERIODS.find((p) => p.value === mem.period);
    if (period) list = list.filter((e) => e.at >= now - period.ms);
    if (mem.listensOnly) list = list.filter(listenLine);
    return list;
  }, [textShown, mem, now]);
  const sessions = useMemo(() => groupSessions(shown).reverse(), [shown]);

  // which sessions are open: in Sessions mode the toggled set is the OPEN set,
  // in Every play it is the CLOSED set
  const [toggled, setToggled] = useState<ReadonlySet<string>>(() =>
    toggledMem.mode === mode ? toggledMem.keys : new Set(),
  );
  const toggledModeRef = useRef(mode);
  useEffect(() => {
    if (toggledModeRef.current === mode) return;
    toggledModeRef.current = mode;
    setToggled(new Set());
  }, [mode]);
  useEffect(() => {
    toggledMem = { mode, keys: toggled };
  }, [mode, toggled]);
  const toggle = (key: string): void =>
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // a month's figures for its divider, from the shown lines (one home: lib/historyStats)
  const monthLines = useMemo(() => {
    const byMonth = new Map<number, ListeningEvent[]>();
    for (const e of shown) {
      const m = monthStartOf(e.at);
      const list = byMonth.get(m);
      if (list) list.push(e);
      else byMonth.set(m, [e]);
    }
    const out = new Map<number, string | null>();
    for (const [m, list] of byMonth) out.set(m, monthLine(statsFor(list)));
    return out;
  }, [shown]);
  const { items, dayOf } = useMemo(() => {
    const items: Item[] = [];
    const dayOf: number[] = [];
    let day: number | null = null;
    let month: number | null = null;
    for (const s of sessions) {
      const d = dayStart(s.endAt);
      const m = monthStartOf(s.endAt);
      if (month !== m) {
        month = m;
        items.push({ kind: "month", key: `m${m}`, month: m, line: monthLines.get(m) ?? null });
        dayOf.push(d);
      }
      if (day !== d) {
        day = d;
        items.push({ kind: "day", key: `d${d}`, day: d });
        dayOf.push(d);
      }
      const key = sessionKey(s);
      const open = mode === "plays" ? !toggled.has(key) : toggled.has(key);
      items.push({ kind: "session", key, session: s, open });
      dayOf.push(d);
      if (open)
        for (let i = s.events.length - 1; i >= 0; i--) {
          const e = s.events[i];
          items.push({ kind: "play", key: `p${e.at}-${i}`, event: e, session: s });
          dayOf.push(d);
        }
    }
    return { items, dayOf };
  }, [sessions, mode, toggled, monthLines]);
  const kinds = useMemo(() => items.map((i) => i.kind), [items]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // the spot is remembered across visits like every other screen's (user,
  // 2026-09-05: ⌘← from an artist landed back at the top); one callback ref
  // feeds both the memory and the windowing hook's element
  const rememberScroll = useScrollMemory("history:timeline");
  const attachScroller = useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current = node;
      rememberScroll(node);
    },
    [rememberScroll],
  );
  const win = useWindowedList({
    scrollRef,
    count: items.length,
    itemSelector: "[data-win-kind]",
    kinds,
    estimate: ITEM_ESTIMATE,
    overscan: 10,
    enabled: items.length > WINDOW_ABOVE,
  });
  const scrollToIndex = (i: number): void => {
    const sc = scrollRef.current;
    if (!sc) return;
    const el = sc.querySelector<HTMLElement>(`[data-win-index="${i}"]`);
    if (el) el.scrollIntoView({ block: "start" });
    else sc.scrollTop = win.offsetOf(i);
  };

  // the month rail: each month's first item, newest first, under its year
  const rail = useMemo(() => {
    const out: Array<{ year: number; months: Array<{ month: number; index: number }> }> = [];
    items.forEach((it, index) => {
      if (it.kind !== "month") return;
      const d = new Date(it.month);
      let y = out[out.length - 1];
      if (!y || y.year !== d.getFullYear()) {
        y = { year: d.getFullYear(), months: [] };
        out.push(y);
      }
      y.months.push({ month: d.getMonth(), index });
    });
    return out;
  }, [items]);
  // THE STICKY DAY: the day under the list's top edge holds a header there,
  // and the next day's real header pushes it away as it arrives (the sticky
  // grammar, done by hand — a windowed list cannot lean on position: sticky,
  // since the governing day header may not be rendered at all). Measured from
  // the DOM per scroll frame; the transform never goes through React.
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [overlayDay, setOverlayDay] = useState<number | null>(null);
  const dayOfRef = useRef(dayOf);
  dayOfRef.current = dayOf;
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    let raf = 0;
    const update = (): void => {
      raf = 0;
      const ov = overlayRef.current;
      if (sc.scrollTop <= 1) {
        setOverlayDay(null);
        return;
      }
      const scTop = sc.getBoundingClientRect().top;
      let idx = -1;
      let nextHeaderTop: number | null = null;
      for (const el of sc.querySelectorAll<HTMLElement>("[data-win-index]")) {
        const r = el.getBoundingClientRect();
        if (r.bottom <= scTop + 1) continue;
        if (el.dataset.winKind === "day") {
          // a day header's box carries 20px of air above its label; the push
          // keys on where the LABEL would sit in the sticky header (its pt-1),
          // so the two labels meet exactly as the real one takes over
          const label = el.querySelector<HTMLElement>("span");
          const labelTop = (label ? label.getBoundingClientRect().top : r.top) - 4;
          if (labelTop > scTop) {
            nextHeaderTop = labelTop;
            break;
          }
        }
        if (idx < 0) idx = Number(el.dataset.winIndex);
      }
      const d = idx >= 0 ? (dayOfRef.current[idx] ?? null) : null;
      setOverlayDay((prev) => (prev === d ? prev : d));
      if (ov) {
        const push =
          nextHeaderTop != null ? Math.max(0, ov.offsetHeight - (nextHeaderTop - scTop)) : 0;
        ov.style.transform = push > 0 ? `translateY(-${push}px)` : "";
      }
    };
    const onScroll = (): void => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    sc.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      sc.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [items]);
  const atMonth =
    overlayDay != null ? new Date(overlayDay) : dayOf[0] != null ? new Date(dayOf[0]) : null;

  // the deep link: land on a play (opening its session first in Sessions mode)
  const [pending, setPending] = useState<number | null>(null);
  const [flash, setFlash] = useState<number | null>(null);
  const jumpYearLoaded =
    historyJump != null && loaded[new Date(historyJump.at).getFullYear()] != null;
  useOneShotAsk(
    historyJump,
    (j) => {
      // the facets step aside so the play is there to land on
      if (timelineMem.source || timelineMem.period || timelineMem.listensOnly)
        setMem({ source: null, period: null, listensOnly: false });
      const s = sessions.find((x) => x.events.some((e) => e.at === j.at));
      if (s && mode === "sessions")
        setToggled((prev) => (prev.has(sessionKey(s)) ? prev : new Set(prev).add(sessionKey(s))));
      setPending(j.at);
    },
    { claim: historyJump?.nonce, clear: clearHistoryJump, ready: jumpYearLoaded },
  );
  useEffect(() => {
    if (pending == null) return;
    const idx = items.findIndex((it) => it.kind === "play" && it.event.at === pending);
    if (idx < 0) return;
    scrollToIndex(idx);
    setFlash(pending);
    setPending(null);
    // scrollToIndex reads the current window; the effect is keyed on the list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, items]);
  useEffect(() => {
    if (flash == null) return;
    const t = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(t);
  }, [flash]);

  // art for the rows on screen: the record carries none, the index knows the
  // track by its content key (one small IPC per slice, cached for the session)
  const slice = useMemo(() => items.slice(win.first, win.last + 1), [items, win.first, win.last]);
  const artKeys = useMemo(
    () =>
      [
        ...new Set(
          slice.flatMap((it) =>
            it.kind === "play" && (it.event.kind === "play" || it.event.kind === "external")
              ? [playKey(it.event.title, it.event.artist, it.event.album)]
              : [],
          ),
        ),
      ].sort(),
    [slice],
  );
  const artByKey = useArtByKeys(artKeys);
  // the device log's art, keyed by content: what the streamer showed for a
  // track the library does not hold (AirPlay, casting), while the log has it
  const recents = useStore((s) => s.recents);
  const recentArt = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of recents)
      if (r.artUrl && r.title && !r.isRadio) {
        const k = playKey(r.title, r.artist, r.album);
        if (!m.has(k)) m.set(k, r.artUrl);
      }
    return m;
  }, [recents]);
  // a station's logo, from the device log's radio entries (Airable's durable URLs)
  const stationArt = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of recents)
      if (r.isRadio && r.station && r.artUrl && !m.has(r.station)) m.set(r.station, r.artUrl);
    return m;
  }, [recents]);
  const artOf = (e: ListeningEvent): string | null => {
    if (e.kind === "radio-session" || e.kind === "radio-track")
      return e.station ? (stationArt.get(e.station) ?? null) : null;
    if (e.kind !== "play" && e.kind !== "external") return null;
    const k = playKey(e.title, e.artist, e.album);
    return artByKey[k] ?? recentArt.get(k) ?? null;
  };

  const [rowMenu, setRowMenu] = useState<{
    title: string;
    x: number;
    y: number;
    items: MediaMenuItem[];
  } | null>(null);
  const openRowMenu = (ev: ListeningPlayEvent, e: React.MouseEvent): void => {
    const ref = fromPlayEvent(ev);
    e.preventDefault();
    e.stopPropagation();
    setRowMenu({
      title: ref.title,
      x: e.clientX,
      y: e.clientY,
      items: trackMenuItems(ref, {
        playNow: () => void playRefNow(ref),
        openInLibrary: () => void openRefInLibrary(ref),
      }),
    });
  };

  const total = all.length;
  if (years != null && years.length === 0) {
    return (
      <EmptyState
        icon={Clock}
        title="No listening recorded yet"
        caption={
          recordOn
            ? "Plays, radio and other sources collect here as they happen. A play is recorded once it has run for thirty seconds."
            : "The listening record is off. Turn it on in Settings › History and plays will collect here."
        }
      />
    );
  }
  const narrowed = filter !== "" || mem.source != null || mem.period != null || mem.listensOnly;

  return (
    <div className="h-full flex flex-col">
      {rowMenu && (
        <RowMenu
          title={rowMenu.title}
          at={{ x: rowMenu.x, y: rowMenu.y }}
          onClose={() => setRowMenu(null)}
          items={rowMenu.items}
        />
      )}
      {/* the unit, then the facets (the lenses' grammar): a group that hides when empty */}
      <div className="flex items-center gap-2 pb-3 px-1 flex-wrap" data-history-toolbar>
        <Segmented<"sessions" | "plays">
          value={mode}
          onChange={(m) => void saveSettings({ historyTimelineMode: m })}
          options={[
            { value: "sessions", label: "Sessions" },
            { value: "plays", label: "Every play" },
          ]}
        />
        <div className="flex items-center gap-2 empty:hidden">
          <PickerPill
            id="source"
            neutral="Source"
            clearLabel="Any source"
            options={sourceOptions}
            value={mem.source}
            onChange={(source) => setMem({ source })}
          />
          <PickerPill
            id="period"
            neutral="Period"
            clearLabel="All time"
            options={periodOptions}
            value={mem.period}
            onChange={(period) => setMem({ period })}
            min={1}
          />
        </div>
        <Chip
          state={mem.listensOnly ? "active" : "idle"}
          onClick={() => setMem({ listensOnly: !mem.listensOnly })}
          data-history-listens-only={mem.listensOnly ? "on" : "off"}
          data-tip={`${LISTEN_DEFINITION} Hides the partial plays.`}
          className="no-drag tip-bottom tip-wide tip-end motion-safe:active:scale-95"
        >
          Listens only
        </Chip>
      </div>
      <div className="flex-1 min-h-0 flex gap-3">
        {/* overflow-hidden: the pushed-away header is clipped at the list's top
            edge, as a scroll container clips its own sticky header — without it
            the header rose over the toolbar (user, 2026-09-05) */}
        <div className="relative flex-1 min-w-0 min-h-0 overflow-hidden">
          {/* the sticky day header (see the effect above): the same face as a
              day header in the list, on the bare ground; the scroller's fade-top
              dissolves the rows before they reach it */}
          <div
            ref={overlayRef}
            data-history-floating-day
            hidden={overlayDay == null}
            className="pointer-events-none absolute inset-x-1 top-0 z-10 flex items-center gap-3 px-1 pt-1 pb-2"
          >
            <span className="microlabel microlabel-strong">
              {overlayDay != null ? dayLabel(overlayDay, now) : ""}
            </span>
            <span aria-hidden className="flex-1 border-t border-edge/60" />
          </div>
          {/* fade-top only while a day is held: at rest the first header must
              not dissolve; scrolled, the rows dissolve before they reach the label */}
          <div
            ref={attachScroller}
            className={cx("h-full overflow-y-auto px-1", overlayDay != null && "fade-top")}
            data-history-timeline
          >
            <div className="max-w-2xl">
              {items.length === 0 && years != null && (
                <div className="text-[15px] text-faint pt-6 px-1">
                  {narrowed ? "Nothing matches these filters" : "Nothing this year yet"}
                </div>
              )}
              {win.padTop > 0 && <div data-win-spacer="top" style={{ height: win.padTop }} />}
              {slice.map((it, i) => {
                const index = win.first + i;
                if (it.kind === "month") {
                  const d = new Date(it.month);
                  const thisYear = d.getFullYear() === new Date(now).getFullYear();
                  return (
                    <div
                      key={it.key}
                      data-win-kind="month"
                      data-win-index={index}
                      data-history-month-divider
                      className="flex items-baseline gap-3 px-1 pt-6 pb-1 first:pt-1"
                    >
                      <span className="shrink-0 font-display text-[15px] text-ink">
                        {d.toLocaleDateString(undefined, {
                          month: "long",
                          ...(thisYear ? {} : { year: "numeric" }),
                        })}
                      </span>
                      {it.line && (
                        <span className="min-w-0 flex-1 truncate text-[11.5px] text-faint">
                          {it.line}
                        </span>
                      )}
                    </div>
                  );
                }
                if (it.kind === "day")
                  return (
                    <div
                      key={it.key}
                      data-win-kind="day"
                      data-win-index={index}
                      className="flex items-center gap-3 pt-5 pb-2 px-1 first:pt-1"
                    >
                      <span className="microlabel microlabel-strong">{dayLabel(it.day, now)}</span>
                      {/* a hairline to the edge: the day boundary reads at a
                          glance, at no cost in height */}
                      <span aria-hidden className="flex-1 border-t border-edge/60" />
                    </div>
                  );
                if (it.kind === "session") {
                  const s = it.session;
                  return (
                    <button
                      key={it.key}
                      type="button"
                      data-win-kind="session"
                      data-win-index={index}
                      data-history-session
                      data-open={it.open ? "true" : "false"}
                      onClick={() => toggle(it.key)}
                      className="w-full flex items-baseline gap-3 px-1 pt-2 pb-1.5 text-left rounded-lg transition-colors hover:bg-veil"
                    >
                      <span className="shrink-0 font-mono text-[11.5px] tabular-nums text-ink">
                        {timeOf(s.startAt)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-dim">
                        {sessionSummary(s)}
                      </span>
                      <span className="shrink-0 text-[11px] text-faint tabular-nums">
                        {fmtDuration((s.endAt - s.startAt) / 1000)}
                      </span>
                      <ChevronRight
                        size={14}
                        className={cx(
                          "shrink-0 self-center text-faint transition-transform",
                          it.open && "rotate-90",
                        )}
                      />
                    </button>
                  );
                }
                const flashed = flash != null && it.event.at === flash;
                return (
                  <div
                    key={it.key}
                    data-win-kind="play"
                    data-win-index={index}
                    data-history-flash={flashed ? "true" : undefined}
                    className={cx("pb-1", flashed && "rounded-xl ring-2 ring-gold/60")}
                  >
                    <EventRow event={it.event} artUrl={artOf(it.event)} onMenu={openRowMenu} />
                  </div>
                );
              })}
              {win.padBottom > 0 && (
                <div data-win-spacer="bottom" style={{ height: win.padBottom }} />
              )}
              <div className="flex items-center gap-4 pt-5 pb-8 px-1">
                <span className="microlabel">
                  {total > 0
                    ? `${fmtCount(total)} ${total === 1 ? "line" : "lines"}${FACT_SEP}${loadedYears.length === 1 ? String(loadedYears[0]) : `${loadedYears[loadedYears.length - 1]} to ${loadedYears[0]}`}`
                    : "…"}
                </span>
                {nextEarlier != null && (
                  <button
                    onClick={() => void loadYear(nextEarlier)}
                    data-history-earlier
                    className="text-[12px] text-dim hover:text-ink underline-offset-2 hover:underline transition-colors"
                  >
                    Show {nextEarlier}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
        {/* the month rail: years as headings, months as landings */}
        {rail.length > 0 && (
          <nav className="w-12 shrink-0 overflow-y-auto pt-1" data-history-months>
            {rail.map((y) => (
              <div key={y.year} className="mb-2">
                <div className="microlabel px-1 pb-1">{y.year}</div>
                {y.months.map((m) => {
                  const current =
                    atMonth != null &&
                    atMonth.getFullYear() === y.year &&
                    atMonth.getMonth() === m.month;
                  return (
                    <button
                      key={m.month}
                      type="button"
                      data-history-month={`${y.year}-${m.month + 1}`}
                      onClick={() => scrollToIndex(m.index)}
                      className={cx(
                        "block w-full rounded px-1 py-0.5 text-left text-[11px] transition-colors",
                        current
                          ? "text-amber bg-amberdim"
                          : "text-faint hover:text-ink hover:bg-veil",
                      )}
                    >
                      {MONTH_LABEL(m.month)}
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}

/** One record line as a row. A library play carries verbs (it has an identity
 *  to act on); a station's song and an external source's track are facts,
 *  at full strength (dimmed means unreachable elsewhere, and these are not). */
function EventRow({
  event: e,
  artUrl,
  onMenu,
}: {
  event: ListeningEvent;
  artUrl: string | null;
  onMenu(ev: ListeningPlayEvent, e: React.MouseEvent): void;
}): React.JSX.Element {
  if (e.kind === "play") {
    const ref = fromPlayEvent(e);
    const listen = isListen(e.playedSeconds, e.duration);
    const heard =
      e.duration != null && !listen
        ? `${fmtTime(e.playedSeconds)} of ${fmtTime(e.duration)}`
        : e.duration != null
          ? fmtTime(e.duration)
          : fmtTime(e.playedSeconds);
    return (
      <MediaRow
        attrs={{ "data-history-row": "play" }}
        title={e.title}
        subtitle={<NameLine artist={e.artist} album={e.album} ref={ref} />}
        kind="track"
        artUrl={artUrl}
        meta={<Meta at={e.at} detail={heard} faded={!listen} />}
        onContextMenu={(ev) => onMenu(e, ev)}
        actions={
          <>
            <RowAction
              icon={Play}
              label="Play again"
              tip="Play now. Slots in after the current track"
              onClick={() => void playRefNow(ref)}
            />
            <RowAction icon={MoreHorizontal} label="More actions" onClick={(ev) => onMenu(e, ev)} />
          </>
        }
      />
    );
  }
  if (e.kind === "radio-track")
    return (
      <MediaRow
        attrs={{ "data-history-row": "radio-track" }}
        title={e.title}
        subtitle={[e.artist, e.station].filter(Boolean).join(FACT_SEP) || undefined}
        kind="station"
        artUrl={artUrl}
        meta={<Meta at={e.at} detail="heard on the radio" faded />}
      />
    );
  if (e.kind === "radio-session")
    return (
      <MediaRow
        attrs={{ "data-history-row": "radio-session" }}
        title={e.station ?? "Radio"}
        subtitle="Internet radio"
        kind="station"
        artUrl={artUrl}
        meta={<Meta at={e.at} detail={fmtDuration((e.playedSeconds * 1000) / 1000)} />}
      />
    );
  return (
    <MediaRow
      attrs={{ "data-history-row": "external" }}
      title={e.title ?? e.source ?? "Another source"}
      subtitle={<NameLine artist={e.artist} album={e.album} />}
      kind="track"
      artUrl={artUrl}
      meta={<Meta at={e.at} detail={e.source ?? "another source"} faded />}
    />
  );
}

function Meta({
  at,
  detail,
  faded,
}: {
  at: number;
  detail: string;
  faded?: boolean;
}): React.JSX.Element {
  return (
    <div className="shrink-0 text-right">
      <div className="text-[11.5px] tabular-nums text-faint">{timeOf(at)}</div>
      <div
        className={cx(
          "text-[10.5px] mt-0.5 tabular-nums",
          faded ? "text-faint/60" : "text-faint/80",
        )}
      >
        {detail}
      </div>
    </div>
  );
}
