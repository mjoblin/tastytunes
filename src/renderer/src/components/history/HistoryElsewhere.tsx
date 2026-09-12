import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ExternalLink, Globe, Library, MoreHorizontal } from "lucide-react";
import { playKey, type ArtistInfo } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { HeaderChip, Chip } from "@/components/chrome/Chrome";
import { EmptyState } from "@/components/chrome/EmptyState";
import { SortChip } from "@/components/controls/SortChip";
import { MediaRow } from "@/components/media/MediaRow";
import { RowAction } from "@/components/media/RowAction";
import { RowMenu } from "@/components/media/RowMenu";
import { useScrollMemory } from "@/hooks/useScrollMemory";
import { useIndexPools } from "@/hooks/useIndexPools";
import { useWholeRecord } from "@/hooks/useWholeRecord";
import { heardElsewhere, type HeardArtist, type HeardTrack } from "@/lib/elsewhere";
import { openArtistInLibrary, openRefInLibrary } from "@/lib/mediaActions";
import type { MediaRef } from "@/lib/mediaRef";
import { cx, fmtCount, fmtRelative, matchesFilter } from "@/lib/format";
import { FACT_SEP } from "@/lib/mediaFacts";

/**
 * The History screen's ELSEWHERE (0.8.0): the artists the record met away from
 * the library (lib/elsewhere), one list. An artist row says how much of them
 * was heard and where, and whether the library holds them; it opens to the
 * tracks heard and, with the Artist info setting on, to the same MusicBrainz
 * and Wikipedia summary Now Playing's context panel shows. The row of an
 * artist the library holds goes to their page there. Nothing here can be
 * played: there is nothing of it to play.
 *
 * SHAPE (user, 2026-09-11, after the first build listed every track and every
 * radio song in three modes): "413 tracks by 363 artists … 2 of them in your
 * library" — the track-level link to the library was empty and the tracks
 * "largely unknown to me; artists I recognize". What he wants of a row: "does
 * it relate to something I own; get more information on it". So the unit is
 * the artist, the relation is at the artist's level (albums of their own in
 * the library, or a credit), and the information is in-app.
 */
type Sort = "heard" | "recent";
let elsewhereMem: { sort: Sort; reversed: boolean; ownedOnly: boolean; open: string[] } = {
  sort: "heard",
  reversed: false,
  ownedOnly: false,
  open: [],
};

/** How many tracks a row may take to the Cover Art Archive before it gives
 *  up: each try there is one or two MusicBrainz requests behind a gate of one
 *  per second, shared with the lookups a user is waiting on, and a list of
 *  hundreds of artists scrolling past must not queue a minute of them. ONE:
 *  the most-heard track that names an album. Saved covers cost nothing and
 *  are tried for every track first. */
const ARCHIVE_TRIES = 1;

/** A heard track's picture, in two parts, each cached on its own key: the
 *  app's own saved copy of an AirPlay cover (captured while the streamer's URL
 *  lived), and the Cover Art Archive when album-art lookups are on (main gates
 *  it and caches its misses). Split so an artist's row can try every track's
 *  saved cover, then a bounded few at the archive. */
const coverCache = new Map<string, Promise<string | null>>();
function savedCover(t: Pick<HeardTrack, "title" | "artist" | "album">): Promise<string | null> {
  const key = playKey(t.title, t.artist, t.album);
  let p = coverCache.get(key);
  if (!p) {
    p = tt.recentCover(key).catch(() => null);
    coverCache.set(key, p);
  }
  return p;
}
const archiveCache = new Map<string, Promise<string | null>>();
function archiveArt(t: Pick<HeardTrack, "artist" | "album">): Promise<string | null> {
  if (!t.artist || !t.album) return Promise.resolve(null);
  const key = `${t.artist.toLowerCase()}|${t.album.toLowerCase()}`;
  let p = archiveCache.get(key);
  if (!p) {
    // answers stay, misses go: main caches the definitive ones itself and a
    // transient failure must not blank the row for the session
    p = tt.albumArt(t.artist, t.album).catch(() => null);
    archiveCache.set(key, p);
    void p.then((u) => u == null && archiveCache.delete(key));
  }
  return p;
}
async function trackArt(t: HeardTrack): Promise<string | null> {
  return (await savedCover(t)) ?? archiveArt(t);
}
/** THE ARTIST'S PICTURE COMES FROM ANY OF THEIR TRACKS, not the most-heard
 *  one alone: that one is often a radio song with no album name, or a play
 *  from before covers were captured, and the row stayed blank while its third
 *  track had a cover (user, 2026-09-12: "should I be seeing more album art?").
 *  Saved covers for every track first, then the archive for the first few
 *  that name an album. */
async function artistArt(tracks: readonly HeardTrack[]): Promise<string | null> {
  for (const t of tracks) {
    const cover = await savedCover(t);
    if (cover) return cover;
  }
  let asked = 0;
  for (const t of tracks) {
    if (!t.artist || !t.album) continue;
    if (asked++ >= ARCHIVE_TRIES) break;
    const art = await archiveArt(t);
    if (art) return art;
  }
  return null;
}
/** How long a row must stay on screen before it asks for its picture: a flick
 *  through a hundred rows then asks for nothing, and stopping on ten asks for
 *  ten. Every row that merely passed through the viewport used to queue a
 *  MusicBrainz search, one a second for as long as the scroll had been (user,
 *  2026-09-12: "i don't want the app to be too demanding on musicbrainz"). */
const DWELL_MS = 500;
/** Asked only once the row has DWELLED on screen: a list of hundreds must not
 *  fire hundreds of lookups. A picture found is kept for the session; a miss
 *  is asked again on the next mount, and main answers a definitive one from
 *  its own cache at once. */
const rowArtCache = new Map<string, Promise<string | null>>();
function useLazyArt(
  ref: React.RefObject<HTMLElement | null>,
  key: string,
  load: () => Promise<string | null>,
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    let dwell = 0;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((x) => x.isIntersecting)) {
        // gone before it dwelled: nothing asked
        if (dwell) clearTimeout(dwell);
        dwell = 0;
        return;
      }
      if (dwell) return;
      dwell = window.setTimeout(() => {
        dwell = 0;
        io.disconnect();
        let p = rowArtCache.get(key);
        if (!p) {
          p = loadRef.current();
          rowArtCache.set(key, p);
        }
        void p.then((u) => {
          if (u == null) rowArtCache.delete(key); // a miss is main's to remember, not ours
          if (live) setUrl(u);
        });
      }, DWELL_MS);
    });
    io.observe(el);
    return () => {
      live = false;
      if (dwell) clearTimeout(dwell);
      io.disconnect();
    };
  }, [ref, key]);
  return url;
}

/** The artist's summary, asked when a row opens and the Artist info setting is
 *  on (the same gate and the same main-process chain as Now Playing's panel;
 *  main caches, this keeps the promise so a reopen is free). */
const aboutCache = new Map<string, Promise<ArtistInfo | null>>();
function useAbout(
  name: string,
  wanted: boolean,
): { status: "off" | "loading" | "ready" | "none"; info: ArtistInfo | null } {
  const enabled = useStore((s) => s.settings.artistInfo);
  const [got, setGot] = useState<{ name: string; info: ArtistInfo | null } | null>(null);
  useEffect(() => {
    if (!wanted || !enabled) return;
    let live = true;
    let p = aboutCache.get(name);
    if (!p) {
      p = tt.fetchArtistInfo(name).catch(() => null);
      aboutCache.set(name, p);
    }
    void p.then((info) => {
      // THE RENDERER REMEMBERS ANSWERS, MAIN REMEMBERS MISSES: main returns null
      // for a search that never happened (a 503, a timeout) and refuses to
      // cache it, so keeping that null here turned one bad second into
      // "Nothing found" for the session (user, 2026-09-12: Dominic Fike).
      if (info == null) aboutCache.delete(name);
      if (live) setGot({ name, info });
    });
    return () => {
      live = false;
    };
  }, [name, wanted, enabled]);
  if (!enabled) return { status: "off", info: null };
  if (!got || got.name !== name) return { status: "loading", info: null };
  return { status: got.info ? "ready" : "none", info: got.info };
}

const refOf = (title: string, artist: string | null, album: string | null): MediaRef => ({
  kind: "track",
  title,
  artist,
  album,
  artUrl: null,
  durationSecs: null,
  url: null,
  serverUdn: null,
  serverName: null,
  objectId: null,
});
const times = (n: number, one: string, many: string): string =>
  `${fmtCount(n)} ${n === 1 ? one : many}`;
/** "A", "A and B", "A, B and C", "A, B and 3 more". */
const listOf = (names: readonly string[], max = 3): string => {
  if (names.length <= max) {
    if (names.length <= 1) return names[0] ?? "";
    return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, max).join(", ")} and ${fmtCount(names.length - max)} more`;
};

export function HistoryElsewhere({
  filter,
  streamer,
  onCounts,
}: {
  filter: string;
  /** The rail's streamer facet: null is every streamer. */
  streamer: string | null;
  /** The header's filter reports shown / total from here. */
  onCounts(shown: number, total: number): void;
}): React.JSX.Element {
  const { events, years, allLoaded } = useWholeRecord(streamer);
  const recordOn = useStore((s) => s.settings.listeningRecord);
  const requestSearch = useStore((s) => s.requestSearch);
  const showToast = useStore((s) => s.showToast);
  const pools = useIndexPools(true);
  const heard = useMemo(() => heardElsewhere(events, pools), [events, pools]);
  const scrollRef = useScrollMemory("history:elsewhere");
  const [sort, setSortState] = useState<Sort>(elsewhereMem.sort);
  const [reversed, setReversed] = useState(elsewhereMem.reversed);
  const [ownedOnly, setOwnedOnly] = useState(elsewhereMem.ownedOnly);
  const [open, setOpen] = useState<string[]>(elsewhereMem.open);
  const remember = (next: Partial<typeof elsewhereMem>): void => {
    elsewhereMem = { ...elsewhereMem, ...next };
  };
  const toggleOpen = (key: string): void => {
    const next = open.includes(key) ? open.filter((k) => k !== key) : [...open, key];
    remember({ open: next });
    setOpen(next);
  };
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const inLibrary = useMemo(() => heard.artists.filter((a) => a.inLibrary), [heard.artists]);
  const pool = ownedOnly ? inLibrary : heard.artists;
  const artists = useMemo(() => {
    const kept = pool.filter((a) =>
      matchesFilter(filter, [
        a.name,
        ...a.tracks.map((t) => t.title),
        ...a.tracks.map((t) => t.album),
        ...a.where,
      ]),
    );
    kept.sort((a, b) =>
      sort === "heard" ? b.heard - a.heard || b.lastAt - a.lastAt : b.lastAt - a.lastAt,
    );
    return reversed ? kept.reverse() : kept;
  }, [pool, filter, sort, reversed]);
  useEffect(() => onCounts(artists.length, pool.length), [onCounts, artists.length, pool.length]);

  const [menu, setMenu] = useState<{
    title: string;
    x: number;
    y: number;
    items: Array<{ label: string; run(): void }>;
    /** Whose menu: the artist's or the track's key, so that row holds its hover. */
    key: string;
  } | null>(null);
  const copy = (text: string): void => {
    void navigator.clipboard
      .writeText(text)
      .then(() => showToast({ kind: "success", text: "Copied." }));
  };
  const lookUp = (query: string, type: "artist" | "recording"): void =>
    void tt.openExternal(
      `https://musicbrainz.org/search?type=${type}&method=indexed&query=${encodeURIComponent(query)}`,
    );
  const trackMenu = (e: React.MouseEvent, t: HeardTrack): void => {
    e.preventDefault();
    e.stopPropagation();
    const q = [t.title, t.artist].filter(Boolean).join(" ");
    setMenu({
      key: t.key,
      title: t.title,
      x: e.clientX,
      y: e.clientY,
      items: [
        ...(t.owned
          ? [
              {
                label: "Open in Library",
                run: () => void openRefInLibrary(refOf(t.title, t.artist, t.album)),
              },
            ]
          : []),
        { label: "Search the library", run: () => requestSearch(q) },
        { label: "Look it up", run: () => lookUp(q, "recording") },
        { label: "Copy", run: () => copy(t.artist ? `${t.artist} - ${t.title}` : t.title) },
      ],
    });
  };
  const artistMenu = (e: React.MouseEvent, a: HeardArtist): void => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      key: a.key,
      title: a.name,
      x: e.clientX,
      y: e.clientY,
      items: [
        ...(a.inLibrary ? [{ label: "Go to artist", run: () => openArtistInLibrary(a.name) }] : []),
        { label: "Search the library", run: () => requestSearch(a.name) },
        { label: "Look it up", run: () => lookUp(a.name, "artist") },
        { label: "Copy", run: () => copy(a.name) },
      ],
    });
  };

  if (years != null && years.length === 0) {
    return (
      <EmptyState
        icon={Globe}
        title="Nothing heard elsewhere yet"
        caption={
          recordOn
            ? "The artists you play through AirPlay, a cast or a streaming service, or hear on internet radio, gather here, with how each relates to your library."
            : "The listening record is off. Turn it on in Settings › History and this list will follow."
        }
      />
    );
  }

  // the summary says what the record actually saw, in its own names
  const via = [
    heard.sources.length > 0 ? `through ${listOf(heard.sources)}` : null,
    heard.stations > 0
      ? `on ${times(heard.stations, "internet radio station", "internet radio stations")}`
      : null,
  ]
    .filter(Boolean)
    .join(", and ");
  const n = heard.artists.length;
  const owned = inLibrary.length;
  const summary =
    n === 0
      ? ""
      : `${times(n, "artist", "artists")} heard ${via}. ${
          owned === 0
            ? "None of them are in your library."
            : `${owned === n ? "All" : fmtCount(owned)} of them ${owned === 1 ? "is" : "are"} in your library.`
        }`;

  return (
    <div className="h-full flex flex-col">
      {menu && (
        <RowMenu
          title={menu.title}
          at={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          items={menu.items}
        />
      )}
      <div className="flex items-center gap-3 pb-3 px-1" data-history-elsewhere-toolbar>
        <Chip
          state={ownedOnly ? "active" : "idle"}
          onClick={() => {
            remember({ ownedOnly: !ownedOnly });
            setOwnedOnly(!ownedOnly);
          }}
          data-elsewhere-owned-only={ownedOnly ? "on" : "off"}
          data-tip="Only the artists your library holds, by an album of their own or a credit on a track."
          className="no-drag tip-bottom tip-wide motion-safe:active:scale-95"
        >
          In your library{owned > 0 ? `${FACT_SEP}${fmtCount(owned)}` : ""}
        </Chip>
        {!allLoaded && <span className="microlabel motion-safe:animate-pulse">reading…</span>}
        <div className="flex-1" />
        <SortChip<Sort>
          sorts={[
            { value: "heard", label: "Most heard" },
            { value: "recent", label: "Last heard" },
          ]}
          neutral="heard"
          value={sort}
          reversed={reversed}
          onChange={(s) => {
            remember({ sort: s, reversed: false });
            setSortState(s);
            setReversed(false);
          }}
          onToggleReverse={() => {
            remember({ reversed: !reversed });
            setReversed(!reversed);
          }}
        />
      </div>
      <div
        ref={scrollRef}
        // ring room, the floating rows' idiom: their ring and hover fill sit
        // outside the border box, and a scroller clips at its padding box
        className="flex-1 min-h-0 overflow-y-auto px-1.5 -mx-1.5 pb-8"
        data-history-elsewhere={ownedOnly ? "owned" : "all"}
      >
        <div className="max-w-2xl">
          {summary && (
            <div className="px-1 pb-3 text-[12px] text-faint" data-elsewhere-summary>
              {summary}
            </div>
          )}
          {artists.length === 0 ? (
            <div className="text-[15px] text-faint pt-3 px-1">
              {filter
                ? `No matches for “${filter}”`
                : ownedOnly
                  ? "None of these artists is in your library yet."
                  : "Nothing heard away from your library yet."}
            </div>
          ) : (
            <div className="space-y-1.5">
              {artists.map((a) => (
                <ArtistRow
                  key={a.key}
                  a={a}
                  now={now}
                  open={open.includes(a.key)}
                  onToggle={() => toggleOpen(a.key)}
                  menuFor={menu?.key ?? null}
                  onMenu={(e) => artistMenu(e, a)}
                  onTrackMenu={trackMenu}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- row pieces

function Meta({
  count,
  lastAt,
  now,
}: {
  count: string;
  lastAt: number;
  now: number;
}): React.JSX.Element {
  return (
    // ONE WIDTH for every row: the time reads "Sep 4" on one and "23 hr ago" on
    // the next, and a column that shrank to its text moved the actions beside
    // it from row to row (user, 2026-09-12). w-20 holds the longest, "59 min ago".
    <div className="shrink-0 w-20 text-right">
      <div className="text-[11.5px] tabular-nums text-faint">{fmtRelative(lastAt, now)}</div>
      <div className="text-[10.5px] mt-0.5 text-faint/70 tabular-nums">{count}</div>
    </div>
  );
}

function More({
  onMenu,
  open,
}: {
  onMenu(e: React.MouseEvent): void;
  /** This row's menu is the one open. */
  open: boolean;
}): React.JSX.Element {
  return <RowAction icon={MoreHorizontal} label="More actions" onClick={onMenu} open={open} />;
}

function ArtistRow({
  a,
  now,
  open,
  onToggle,
  menuFor,
  onMenu,
  onTrackMenu,
}: {
  a: HeardArtist;
  now: number;
  open: boolean;
  onToggle(): void;
  /** The key of the row whose menu is open, this artist's or one of its tracks'. */
  menuFor: string | null;
  onMenu(e: React.MouseEvent): void;
  onTrackMenu(e: React.MouseEvent, t: HeardTrack): void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  // the count is in the key: the record loads a year at a time, and a row that
  // resolved on a partial track list looks again when more of them arrive
  const art = useLazyArt(ref, `artist:${a.key}:${a.tracks.length}`, () => artistArt(a.tracks));
  // which kind of page the Library has for them: their albums, or the tracks
  // that credit them — the second is what a Go to artist will show
  const relation =
    a.albums > 0
      ? `in your library, ${times(a.albums, "album", "albums")}`
      : a.credits > 0
        ? `credited on ${times(a.credits, "track", "tracks")} in your library`
        : null;
  const line = [`${times(a.tracks.length, "track", "tracks")} heard`, listOf(a.where), relation]
    .filter(Boolean)
    .join(FACT_SEP);
  return (
    <div ref={ref} data-elsewhere-artist={a.key} data-open={open ? "" : undefined}>
      <MediaRow
        attrs={{ "data-elsewhere-row": "artist", "data-owned": a.inLibrary ? "" : undefined }}
        held={menuFor === a.key}
        title={a.name}
        subtitle={line}
        kind="artist"
        artUrl={art}
        // THE DISCLOSURE IS A MARK, NOT AN ACTION: the Timeline's session rows'
        // chevron, at the row's far edge, always there, turned when open. It sat
        // among the hover actions first, pinned while open, and read as a boxed
        // third button between two others (user, 2026-09-11: "a bit weird").
        meta={
          <span className="flex items-center gap-2">
            <Meta count={times(a.heard, "time", "times")} lastAt={a.lastAt} now={now} />
            <ChevronRight
              size={14}
              className={cx("shrink-0 text-faint transition-transform", open && "rotate-90")}
              data-elsewhere-disclosure={open ? "open" : "closed"}
            />
          </span>
        }
        // the row OPENS; the artist's page in the Library is the action beside
        // it, so every row answers a click the same way whether or not the
        // library holds the artist
        onClick={onToggle}
        onContextMenu={onMenu}
        actions={
          <>
            {a.inLibrary && (
              <RowAction
                icon={Library}
                label="Go to artist"
                tip="Go to artist"
                onClick={() => openArtistInLibrary(a.name)}
              />
            )}
            <More onMenu={onMenu} open={menuFor === a.key} />
          </>
        }
      />
      {open && (
        <div className="ml-12 mr-1 mt-1 mb-3 space-y-2" data-elsewhere-open={a.key}>
          <About name={a.name} />
          <div className="space-y-1">
            {a.tracks.map((t) => (
              <TrackRow
                key={t.key}
                t={t}
                now={now}
                held={menuFor === t.key}
                onMenu={(e) => onTrackMenu(e, t)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** The artist's summary, as Now Playing's context panel has it: the name
 *  MusicBrainz matched, the Wikipedia extract clamped to a few lines until
 *  asked, and the two links out. Nothing at all when the setting is off — the
 *  row's menu still offers Look it up. */
function About({ name }: { name: string }): React.JSX.Element | null {
  const { status, info } = useAbout(name, true);
  const [whole, setWhole] = useState(false);
  if (status === "off") return null;
  if (status === "loading")
    return (
      <div className="px-1 text-[12px] text-faint" data-elsewhere-about="loading">
        Looking up {name}…
      </div>
    );
  if (status === "none" || !info)
    return (
      <div className="px-1 text-[12px] text-faint" data-elsewhere-about="none">
        Nothing found on MusicBrainz for {name}.
      </div>
    );
  return (
    <div className="px-1 space-y-2" data-elsewhere-about="ready">
      {info.summary ? (
        <p
          className={cx(
            "text-[13px] leading-relaxed text-dim whitespace-pre-wrap max-w-xl",
            !whole && "line-clamp-4",
          )}
        >
          {info.summary}
        </p>
      ) : (
        <p className="text-[12px] text-faint">
          Matched on MusicBrainz, but no Wikipedia summary is linked.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {info.summary && !whole && (
          <HeaderChip
            onClick={() => setWhole(true)}
            className="microlabel px-2.5 py-1.5 motion-safe:active:scale-90"
          >
            read more
          </HeaderChip>
        )}
        {info.wikipediaUrl && (
          <HeaderChip
            onClick={() => void tt.openExternal(info.wikipediaUrl ?? "")}
            className="microlabel flex items-center gap-1.5 px-2.5 py-1.5 motion-safe:active:scale-90"
          >
            wikipedia <ExternalLink size={10} />
          </HeaderChip>
        )}
        {info.musicbrainzUrl && (
          <HeaderChip
            onClick={() => void tt.openExternal(info.musicbrainzUrl ?? "")}
            className="microlabel flex items-center gap-1.5 px-2.5 py-1.5 motion-safe:active:scale-90"
          >
            musicbrainz <ExternalLink size={10} />
          </HeaderChip>
        )}
      </div>
    </div>
  );
}

function TrackRow({
  t,
  now,
  held,
  onMenu,
}: {
  t: HeardTrack;
  now: number;
  held: boolean;
  onMenu(e: React.MouseEvent): void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const art = useLazyArt(ref, `track:${t.key}`, () => trackArt(t));
  const line = [t.album, listOf(t.where), t.owned ? "in your library" : null]
    .filter(Boolean)
    .join(FACT_SEP);
  return (
    <div ref={ref}>
      <MediaRow
        attrs={{ "data-elsewhere-row": "track", "data-owned": t.owned ? "" : undefined }}
        held={held}
        title={t.title}
        subtitle={line || undefined}
        kind="track"
        artUrl={art}
        dense
        meta={<Meta count={times(t.heard, "time", "times")} lastAt={t.lastAt} now={now} />}
        onClick={
          t.owned ? () => void openRefInLibrary(refOf(t.title, t.artist, t.album)) : undefined
        }
        onContextMenu={onMenu}
        actions={<More onMenu={onMenu} open={held} />}
      />
    </div>
  );
}
