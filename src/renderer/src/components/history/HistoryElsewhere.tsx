import { useEffect, useMemo, useRef, useState } from "react";
import { Globe, MoreHorizontal } from "lucide-react";
import { playKey } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { EmptyState } from "@/components/chrome/EmptyState";
import { Segmented } from "@/components/controls/Segmented";
import { SortChip } from "@/components/controls/SortChip";
import { MediaRow } from "@/components/media/MediaRow";
import { RowAction } from "@/components/media/RowAction";
import { RowMenu } from "@/components/media/RowMenu";
import { useScrollMemory } from "@/hooks/useScrollMemory";
import { useIndexPools } from "@/hooks/useIndexPools";
import { useWholeRecord } from "@/hooks/useWholeRecord";
import {
  heardElsewhere,
  type HeardArtist,
  type HeardRadioSong,
  type HeardTrack,
} from "@/lib/elsewhere";
import { openArtistInLibrary, openRefInLibrary } from "@/lib/mediaActions";
import type { MediaRef } from "@/lib/mediaRef";
import { fmtCount, fmtRelative, matchesFilter } from "@/lib/format";
import { FACT_SEP } from "@/lib/mediaFacts";

/**
 * The History screen's ELSEWHERE (0.8.0): what the record heard outside the
 * library (lib/elsewhere). A feed you scan, so the floating MediaRow. Artists
 * by default, because streaming mixes play one song each from hundreds of
 * albums and the artist is what turns that into a list you can read; Tracks for
 * every song; Radio for what the stations announced. Something the library
 * holds says so and opens there; the rest can be searched for, looked up, or
 * copied, never played (there is nothing of it to play).
 */
type Mode = "artists" | "tracks" | "radio";
type Sort = "heard" | "recent";
let elsewhereMem: { mode: Mode; sort: Sort; reversed: boolean } = {
  mode: "artists",
  sort: "heard",
  reversed: false,
};

/** A heard track's picture: the app's own saved copy of an AirPlay cover
 *  (captured while the streamer's URL lived), then the Cover Art Archive when
 *  album-art lookups are on (main gates it). Once per track, cached. */
const artCache = new Map<string, Promise<string | null>>();
function heardArt(
  title: string,
  artist: string | null,
  album: string | null,
): Promise<string | null> {
  const key = playKey(title, artist, album);
  let p = artCache.get(key);
  if (!p) {
    p = (async () => {
      const cover = await tt.recentCover(key).catch(() => null);
      if (cover) return cover;
      return artist && album ? tt.albumArt(artist, album).catch(() => null) : null;
    })();
    artCache.set(key, p);
  }
  return p;
}
/** Asked only once the row is on screen: a list of hundreds must not fire hundreds of lookups. */
function useHeardArt(
  ref: React.RefObject<HTMLElement | null>,
  title: string,
  artist: string | null,
  album: string | null,
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((x) => x.isIntersecting)) return;
      io.disconnect();
      void heardArt(title, artist, album).then((u) => {
        if (live) setUrl(u);
      });
    });
    io.observe(el);
    return () => {
      live = false;
      io.disconnect();
    };
  }, [ref, title, artist, album]);
  return url;
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
  const [mode, setModeState] = useState<Mode>(elsewhereMem.mode);
  const [sort, setSortState] = useState<Sort>(elsewhereMem.sort);
  const [reversed, setReversed] = useState(elsewhereMem.reversed);
  const remember = (next: Partial<typeof elsewhereMem>): void => {
    elsewhereMem = { ...elsewhereMem, ...next };
  };
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const order = <T extends { heard: number; lastAt: number }>(list: T[]): T[] => {
    const sorted = [...list].sort((a, b) =>
      sort === "heard" ? b.heard - a.heard || b.lastAt - a.lastAt : b.lastAt - a.lastAt,
    );
    return reversed ? sorted.reverse() : sorted;
  };
  const artists = useMemo(
    () => order(heard.artists.filter((a) => matchesFilter(filter, [a.name, a.top.album]))),
    // order reads sort and reversed, both listed
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [heard.artists, filter, sort, reversed],
  );
  const tracks = useMemo(
    () =>
      order(
        heard.tracks.filter((t) => matchesFilter(filter, [t.title, t.artist, t.album, t.source])),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [heard.tracks, filter, sort, reversed],
  );
  const radio = useMemo(
    () =>
      order(heard.radio.filter((r) => matchesFilter(filter, [r.song, r.artist, ...r.stations]))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [heard.radio, filter, sort, reversed],
  );
  const total =
    mode === "artists"
      ? heard.artists.length
      : mode === "tracks"
        ? heard.tracks.length
        : heard.radio.length;
  const shown =
    mode === "artists" ? artists.length : mode === "tracks" ? tracks.length : radio.length;
  useEffect(() => onCounts(shown, total), [onCounts, shown, total]);

  const [menu, setMenu] = useState<{
    title: string;
    x: number;
    y: number;
    items: Array<{ label: string; run(): void }>;
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
  const trackMenu = (
    e: React.MouseEvent,
    title: string,
    artist: string | null,
    album: string | null,
    owned: boolean,
  ): void => {
    e.preventDefault();
    e.stopPropagation();
    const q = [title, artist].filter(Boolean).join(" ");
    setMenu({
      title,
      x: e.clientX,
      y: e.clientY,
      items: [
        ...(owned
          ? [
              {
                label: "Open in Library",
                run: () => void openRefInLibrary(refOf(title, artist, album)),
              },
            ]
          : []),
        { label: "Search the library", run: () => requestSearch(q) },
        { label: "Look it up", run: () => lookUp(q, "recording") },
        { label: "Copy", run: () => copy(artist ? `${artist} - ${title}` : title) },
      ],
    });
  };
  const artistMenu = (e: React.MouseEvent, a: HeardArtist): void => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      title: a.name,
      x: e.clientX,
      y: e.clientY,
      items: [
        ...(a.owned > 0 ? [{ label: "Go to artist", run: () => openArtistInLibrary(a.name) }] : []),
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
            ? "Music you play through AirPlay or hear on internet radio gathers here, with whether your library has it."
            : "The listening record is off. Turn it on in Settings › History and this list will follow."
        }
      />
    );
  }

  const ownedTracks = heard.tracks.filter((t) => t.owned).length;
  const ownedRadio = heard.radio.filter((r) => r.owned).length;
  const summary =
    mode === "radio"
      ? `${times(heard.radio.length, "song", "songs")} announced on ${times(heard.stations, "station", "stations")}, ${fmtCount(ownedRadio)} of them in your library.`
      : `${times(heard.tracks.length, "track", "tracks")} by ${times(heard.artists.length, "artist", "artists")} heard outside your library's player, ${fmtCount(ownedTracks)} of them in your library.`;

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
        <Segmented<Mode>
          value={mode}
          onChange={(m) => {
            remember({ mode: m });
            setModeState(m);
          }}
          options={[
            { value: "artists", label: "Artists" },
            { value: "tracks", label: "Tracks" },
            { value: "radio", label: "Radio" },
          ]}
        />
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
        data-history-elsewhere={mode}
      >
        <div className="max-w-2xl">
          <div className="px-1 pb-3 text-[12px] text-faint" data-elsewhere-summary>
            {summary}
          </div>
          {shown === 0 ? (
            <div className="text-[15px] text-faint pt-3 px-1">
              {filter
                ? `No matches for “${filter}”`
                : mode === "radio"
                  ? "No radio songs yet. Songs your stations announce show up here."
                  : "Nothing heard outside your library yet."}
            </div>
          ) : (
            <div className="space-y-1.5">
              {mode === "artists" &&
                artists.map((a) => (
                  <ArtistRow key={a.key} a={a} now={now} onMenu={(e) => artistMenu(e, a)} />
                ))}
              {mode === "tracks" &&
                tracks.map((t) => (
                  <TrackRow
                    key={t.key}
                    t={t}
                    now={now}
                    onMenu={(e) => trackMenu(e, t.title, t.artist, t.album, t.owned)}
                  />
                ))}
              {mode === "radio" &&
                radio.map((r) => (
                  <RadioRow
                    key={r.key}
                    r={r}
                    now={now}
                    onMenu={(e) => trackMenu(e, r.song, r.artist, null, r.owned)}
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
    <div className="shrink-0 text-right">
      <div className="text-[11.5px] tabular-nums text-faint">{fmtRelative(lastAt, now)}</div>
      <div className="text-[10.5px] mt-0.5 text-faint/70 tabular-nums">{count}</div>
    </div>
  );
}

function More({ onMenu }: { onMenu(e: React.MouseEvent): void }): React.JSX.Element {
  return <RowAction icon={MoreHorizontal} label="More actions" onClick={onMenu} />;
}

function ArtistRow({
  a,
  now,
  onMenu,
}: {
  a: HeardArtist;
  now: number;
  onMenu(e: React.MouseEvent): void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const art = useHeardArt(ref, a.top.title, a.top.artist, a.top.album);
  const what =
    a.tracks === 1
      ? `1 track${a.top.album ? `${FACT_SEP}${a.top.album}` : ""}`
      : `${fmtCount(a.tracks)} tracks from ${times(a.albums, "album", "albums")}`;
  const owned =
    a.owned === 0
      ? null
      : a.owned === a.tracks
        ? "in your library"
        : `${fmtCount(a.owned)} in your library`;
  return (
    <div ref={ref}>
      <MediaRow
        attrs={{ "data-elsewhere-row": "artist", "data-owned": owned ? "" : undefined }}
        title={a.name}
        subtitle={owned ? `${what}${FACT_SEP}${owned}` : what}
        kind="artist"
        artUrl={art}
        meta={<Meta count={times(a.heard, "play", "plays")} lastAt={a.lastAt} now={now} />}
        onClick={owned ? () => openArtistInLibrary(a.name) : undefined}
        onContextMenu={onMenu}
        actions={<More onMenu={onMenu} />}
      />
    </div>
  );
}

function TrackRow({
  t,
  now,
  onMenu,
}: {
  t: HeardTrack;
  now: number;
  onMenu(e: React.MouseEvent): void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const art = useHeardArt(ref, t.title, t.artist, t.album);
  const line = [t.artist, t.album, t.owned ? "in your library" : null]
    .filter(Boolean)
    .join(FACT_SEP);
  return (
    <div ref={ref}>
      <MediaRow
        attrs={{ "data-elsewhere-row": "track", "data-owned": t.owned ? "" : undefined }}
        title={t.title}
        subtitle={line || undefined}
        kind="track"
        artUrl={art}
        meta={<Meta count={times(t.heard, "play", "plays")} lastAt={t.lastAt} now={now} />}
        onClick={
          t.owned ? () => void openRefInLibrary(refOf(t.title, t.artist, t.album)) : undefined
        }
        onContextMenu={onMenu}
        actions={<More onMenu={onMenu} />}
      />
    </div>
  );
}

function RadioRow({
  r,
  now,
  onMenu,
}: {
  r: HeardRadioSong;
  now: number;
  onMenu(e: React.MouseEvent): void;
}): React.JSX.Element {
  const line = [r.artist, r.stations.join(", "), r.owned ? "in your library" : null]
    .filter(Boolean)
    .join(FACT_SEP);
  return (
    <MediaRow
      attrs={{ "data-elsewhere-row": "radio", "data-owned": r.owned ? "" : undefined }}
      title={r.song}
      subtitle={line || undefined}
      kind="station"
      meta={<Meta count={times(r.heard, "time", "times")} lastAt={r.lastAt} now={now} />}
      onClick={r.owned ? () => void openRefInLibrary(refOf(r.song, r.artist, null)) : undefined}
      onContextMenu={onMenu}
      actions={<More onMenu={onMenu} />}
    />
  );
}
