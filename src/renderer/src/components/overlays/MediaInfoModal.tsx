import { useEffect, useMemo, useState, useRef } from "react";
import {
  AudioLines,
  Copy,
  Check,
  ChevronLeft,
  ChevronRight,
  Disc3,
  Library,
  Music2,
  User,
} from "lucide-react";
import {
  albumComposers,
  albumDrKey,
  albumFormat,
  audioAnalysisKey,
  discCountIn,
  discGroups,
  fmtBytes,
  keyName,
  orderTracks,
  tempoBpm,
  trackArtists,
  trackPosition,
  type MediaInfoTarget,
  type MediaNode,
} from "@shared/model";
import { tt } from "@/api";
import { albumDr14 } from "@/lib/dr14";
import { analyzeAlbum, useAlbumDr } from "@/lib/audioAnalysis";
import { artSrc } from "@/lib/artSrc";
import { useStore } from "@/store";
import { ModalShell } from "@/components/chrome/Overlay";
import { CloseButton } from "@/components/controls/CloseButton";
import { ArtImage } from "@/components/media/ArtImage";
import {
  DrBadge,
  DrChip,
  InfoWaveform,
  useKnownAnalysis,
  warmAnalysis,
} from "@/components/media/Waveform";
import {
  FACT_SEP,
  albumFactsLine,
  albumFormatChips,
  albumFromTracks,
  trackFactsLine,
  trackFormatChips,
} from "@/lib/mediaFacts";
import {
  InfoSections,
  Section,
  sourceRows,
  streamRows,
  trackFormatRows,
  type Row,
  loudnessLine,
} from "@/components/media/InfoRows";
import { cx, fmtTime } from "@/lib/format";
import { openRefInLibrary } from "@/lib/mediaActions";
import { fromNode } from "@/lib/mediaRef";
import {
  canStep,
  infoBack,
  openInfoInList,
  pushInfo,
  setInfoWarmer,
  stepInfo,
} from "@/lib/infoSteps";
import { openInfoForRef } from "@/lib/mediaInfo";
import { isAlbumClass, isArtistClass } from "@/lib/media";
import { IS_MAC } from "@/lib/screens";

/**
 * The Info modal: everything the server said about a piece of media, laid out
 * plainly (user ask, 2026-08-16). The rows and headers stay quiet on purpose
 * — THIS is where the detail lives. Three sections when they apply: what it
 * is (identity), how it's encoded (format), where it came from (source).
 * For an album, the caller hands over the tracks it already knows belong to
 * it, so runtime / size / format / composers are summed here, the same
 * derivations the album leaf and the lens use (albumFormat, albumComposers)
 * — never a second reading. "Copy as JSON" hands the raw node(s) to the
 * clipboard for bug reports.
 */

// A step shows the next track whole (lib/infoSteps): its analysis looked up and its cover
// decoded before the swap
setInfoWarmer(async ({ node, serverUdn }) => {
  const udn = node.serverUdn ?? serverUdn ?? null;
  const art = artSrc(node.artUrl, 128);
  await Promise.all([
    udn && !node.isContainer ? warmAnalysis(udn, node.id, audioAnalysisKey(node)) : null,
    art ? preloadImage(art) : null,
  ]);
});

function preloadImage(src: string): Promise<void> {
  const img = new Image();
  img.src = src;
  return img.decode().catch(() => {});
}

/** A track's place in the header's small label, as Now Playing says it: "track 4 of 12", with
 *  its disc on an album of several; plain "track" without a number (0.12.0, his ask once the
 *  ‹ › made moving between tracks easy). */
function trackLabel(node: MediaNode, count: number | null): string {
  const pos = trackPosition(node);
  if (pos == null) return "track";
  const disc =
    node.discNumber != null &&
    ((node.discCount ?? 0) > 1 || (node.discCount == null && node.discNumber > 1))
      ? `${FACT_SEP}disc ${node.discNumber}${node.discCount ? ` of ${node.discCount}` : ""}`
      : "";
  return `track ${pos}${count ? ` of ${count}` : ""}${disc}`;
}

function kindOf(node: MediaNode): "album" | "artist" | "folder" | "track" {
  if (!node.isContainer) return "track";
  if (isArtistClass(node.upnpClass)) return "artist";
  if (isAlbumClass(node.upnpClass)) return "album";
  return "folder";
}

/**
 * Mounted permanently by App; `target` null means closed. The body keeps
 * rendering the LAST target through the shell's exit fade (the shell holds
 * its last children, but this component's hooks need a node to run against),
 * and unmounts once nothing has ever been shown.
 */
export function MediaInfoModal({
  target,
}: {
  target: MediaInfoTarget | null;
}): React.JSX.Element | null {
  const last = useRef<MediaInfoTarget | null>(null);
  if (target) last.current = target;
  const shown = target ?? last.current;
  if (!shown) return null;
  return <MediaInfoBody target={shown} open={target != null} />;
}

function MediaInfoBody({
  target,
  open,
}: {
  target: MediaInfoTarget;
  open: boolean;
}): React.JSX.Element {
  const setMediaInfo = useStore((s) => s.setMediaInfo);
  const close = (): void => setMediaInfo(null);
  const {
    node: given,
    tracks,
    serverName,
    serverUdn,
    note,
    artist,
    stream,
    serverProfile,
  } = target;
  const placeCount = target.discTrackCount ?? null;
  const kind = kindOf(given);
  // an album shows what its tracks say where it is silent, as the Library header does
  // (lib/mediaFacts); Copy as JSON, the album's DR key and its sweep keep the node as it was
  // given, as the header's do
  const node = useMemo(
    () => (kind === "album" && tracks ? albumFromTracks(given, tracks) : given),
    [kind, given, tracks],
  );
  const [copied, setCopied] = useState(false);
  // the list it was opened from, for the ‹ › (lib/infoSteps); tracks only
  const infoList = useStore((s) => s.mediaInfoList);
  // the page behind this one in the window's own history (lib/infoSteps)
  const backTo = useStore((s) => s.mediaInfoBack.at(-1) ?? null);
  const stepping = infoList != null && kind === "track";
  const session = stepping ? infoList.session : null;
  // THE HEIGHT HOLDS WHILE STEPPING: the modal sizes to its content and sits centered, so a
  // shorter track would move the arrows out from under the pointer; for one open of a list it
  // only ever grows (the body takes the slack, the footer stays put), whenever its content grows
  // (a step, or a waveform landing after one)
  const footRef = useRef<HTMLDivElement | null>(null);
  const [hold, setHold] = useState<{ session: number; h: number } | null>(null);
  useEffect(() => {
    const panel = footRef.current?.parentElement;
    if (session == null || !open || !panel) return;
    const grow = (): void => {
      const h = Math.ceil(panel.getBoundingClientRect().height);
      setHold((cur) => (cur && cur.session === session && cur.h >= h ? cur : { session, h }));
    };
    grow();
    const ro = new ResizeObserver(grow);
    ro.observe(panel);
    return () => ro.disconnect();
  }, [session, open]);
  const minHeight = session != null && hold?.session === session ? hold.h : undefined;

  const copy = (): void => {
    const payload = tracks && tracks.length > 0 ? { node: given, tracks } : given;
    void navigator.clipboard.writeText(JSON.stringify(payload, null, 2)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  // ---- analysis (EXPERIMENT, 0.7): the track's known analysis feeds the
  // header's DR chip, the Format row and the waveform from ONE state; an
  // album's coverage comes from one bulk cache-only read of its tracks.
  const udn = node.serverUdn ?? serverUdn ?? null;
  const known = useKnownAnalysis(kind === "track" ? udn : null, node.id, audioAnalysisKey(node));
  const trackDr =
    known.state != null && known.state !== "loading" && known.state !== "unknown"
      ? known.state.dr
      : null;
  const trackLoud =
    known.state != null && known.state !== "loading" && known.state !== "unknown"
      ? {
          lufs: known.state.lufs ?? null,
          truePeakDb: known.state.truePeakDb ?? null,
          lra: known.state.lra ?? null,
        }
      : null;
  // tempo and key, above their confidence floors (shared/model)
  const trackMeasured =
    known.state != null && known.state !== "loading" && known.state !== "unknown"
      ? { tempo: tempoBpm(known.state.features?.beats), key: keyName(known.state.features?.key) }
      : null;
  const waveformsOn = useStore((s) => s.settings.waveforms);
  const albumDrMap = useAlbumDr();
  const albumEntry = kind === "album" ? (albumDrMap[albumDrKey(given)] ?? null) : null;
  const progress = useStore((s) => s.analysisProgress);
  const sweeping = kind === "album" && progress?.key === albumDrKey(given);
  // each measured track's DR by its analysis key: the coverage line counts them, the Tracks
  // section shows each beside its track
  const [trackDrMap, setTrackDrMap] = useState<Record<string, number> | null>(null);
  const [coverageNonce, setCoverageNonce] = useState(0);
  useEffect(() => {
    if (kind !== "album" || !tracks || tracks.length === 0 || !waveformsOn) {
      setTrackDrMap(null);
      return;
    }
    let stale = false;
    void tt
      .audioDrMany(tracks.map((t) => audioAnalysisKey(t)))
      .then((m) => {
        if (!stale) setTrackDrMap(m);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [kind, tracks, waveformsOn, coverageNonce]);
  const trackDrs = trackDrMap ? Object.values(trackDrMap) : null;
  const albumTotal = tracks?.length ?? 0;
  const albumKnown = trackDrs?.length ?? 0;
  const albumComplete = albumTotal > 0 && albumKnown === albumTotal;
  const albumDr = albumEntry?.dr ?? (albumComplete && trackDrs ? albumDr14(trackDrs) : null);
  const drRange =
    trackDrs && trackDrs.length > 0
      ? { min: Math.min(...trackDrs), max: Math.max(...trackDrs) }
      : null;
  // ---- from an album to its tracks and back (0.12.0, his word on the mockup): a row of the
  // album's Tracks section opens that track's Info, ‹ › stepping the album in its order, and
  // the track's album name comes back to this album as it was; a track's Info opened anywhere
  // else finds its album by name in the index
  const orderedTracks = useMemo(
    () => (kind === "album" && tracks && tracks.length > 0 ? orderTracks(tracks) : null),
    [kind, tracks],
  );
  const trackTargetFor = (t: MediaNode): MediaInfoTarget => {
    const count = tracks ? discCountIn(t, tracks) : null;
    return {
      node: t,
      serverName: serverName ?? null,
      serverUdn: t.serverUdn ?? serverUdn ?? null,
      ...(serverProfile ? { serverProfile } : {}),
      ...(count != null ? { discTrackCount: count } : {}),
    };
  };
  const openTrack = (t: MediaNode): void => {
    if (!orderedTracks) return;
    // a new page of the window's history: back returns to this album (lib/infoSteps)
    openInfoInList(
      trackTargetFor(t),
      orderedTracks.map((x) => () => trackTargetFor(x)),
      orderedTracks.indexOf(t),
      target,
      { push: true },
    );
  };
  const albumUp =
    kind === "track" && node.album
      ? (): void => {
          if (infoList?.parent) {
            pushInfo(infoList.parent);
            return;
          }
          void openInfoForRef(
            {
              ...fromNode(node, serverUdn ?? null, serverName ?? null),
              kind: "album",
              title: node.album ?? "",
              artist: node.albumArtist ?? node.artist,
              album: null,
              durationSecs: null,
              objectId: null,
            },
            undefined,
            { push: true },
          );
        }
      : null;
  const albumName =
    kind === "track" && node.album ? (
      albumUp ? (
        <AlbumLink name={node.album} onGo={albumUp} />
      ) : (
        node.album
      )
    ) : null;

  const runAlbumAnalysis = (): void => {
    if (!udn) return;
    void analyzeAlbum(given, udn, []).then(() => setCoverageNonce((n) => n + 1));
  };
  const headerDr = kind === "track" ? trackDr : kind === "album" ? albumDr : null;
  // NO LOUDNESS CHIP in this header (0.12.0, his call: seven chips wrapped to a second row): a
  // track's loudness ends the waveform's caption just below and has its Format row, an album's
  // its Album row; the header keeps the format and DR. The Library's album header keeps its chip
  // the catalog facts line — the Library album header's exact string (one
  // home, lib/mediaFacts); a track gets its own in the same register
  const factsLine =
    kind === "track"
      ? trackFactsLine(node)
      : kind === "album" && tracks && tracks.length > 0
        ? albumFactsLine(node, tracks)
        : "";

  // the format TOKENS beside it, as chips: a track's and an album's in the one compact spelling
  // (codec, depth/rate), the rest in the Format rows below
  const chips: string[] =
    kind === "track"
      ? trackFormatChips(node.format)
      : kind === "album" && tracks && tracks.length > 0
        ? albumFormatChips(tracks)
        : [];

  // ---- identity
  const performers = trackArtists(node);
  const identity: Row[] =
    kind === "track"
      ? [
          ["Title", node.title],
          ["Performers", performers.length > 1 ? performers.join(", ") : (node.artist ?? null)],
          ["Album artist", node.albumArtist ?? null],
          ["Album", albumName],
          ["Composers", node.composers?.join(", ") ?? null],
          ["Year", node.year ?? null],
          ["Genres", node.genre?.join(", ") ?? null],
          [
            "Position",
            node.trackNumber != null
              ? `${trackPosition(node)}${node.discNumber != null ? `${FACT_SEP}disc ${node.discNumber}${node.discCount ? ` of ${node.discCount}` : ""}` : ""}`
              : null,
          ],
          ["Duration", node.durationSecs != null ? fmtTime(node.durationSecs) : null],
        ]
      : kind === "album"
        ? [
            ["Title", node.title],
            ["Artist", node.artist ?? null],
            ["Year", node.year ?? null],
            ["Genres", node.genre?.join(", ") ?? null],
          ]
        : [["Name", node.title], ...(node.artist ? ([["Artist", node.artist]] as Row[]) : [])];

  // ---- format (a track's own; an album's summed from its tracks)
  const trackFormat: Row[] =
    kind === "track" ? trackFormatRows(node, trackDr, trackLoud, trackMeasured) : [];
  const albumRows: Row[] = (() => {
    if (kind !== "album" || !tracks || tracks.length === 0) return [];
    const secs = tracks.reduce((a, t) => a + (t.durationSecs ?? 0), 0);
    const bytes = tracks.reduce((a, t) => a + (t.format?.sizeBytes ?? 0), 0);
    const fmt = albumFormat(tracks);
    const odd = fmt.notes.filter(Boolean).length;
    const discs = discGroups(tracks).filter((g) => g.disc != null).length;
    const composers = albumComposers(tracks);
    return [
      ["Tracks", String(tracks.length)],
      ["Discs", discs > 1 ? String(discs) : null],
      ["Runtime", secs > 0 ? fmtTime(secs) : null],
      ["Size", bytes > 0 ? fmtBytes(bytes) : null],
      [
        "Format",
        fmt.label
          ? `${fmt.label}${odd > 0 ? ` (${odd} ${odd === 1 ? "track differs" : "tracks differ"})` : ""}`
          : null,
      ],
      ["Composers", composers.length > 0 ? composers.join(", ") : null],
      // the album's integrated loudness (R128, gated across every track)
      ["Loudness", loudnessLine({ lufs: albumEntry?.lufs ?? null, truePeakDb: null })],
    ];
  })();

  // ---- an artist's library page (artistSummary — shared with MCP)
  const list = (items: string[], max: number): React.ReactNode =>
    items.length === 0 ? null : (
      <span>
        {items.slice(0, max).join(FACT_SEP)}
        {items.length > max ? (
          <span className="text-faint">
            {FACT_SEP}+{items.length - max} more
          </span>
        ) : null}
      </span>
    );
  // Lists read as ROWS, the name in ink and its facts quiet beside it — a
  // "·"-joined sentence made a shelf of albums look like a paragraph
  // (user, 2026-08-16).
  const rows = (items: { name: string; meta: string | null }[], max: number): React.ReactNode =>
    items.length === 0 ? null : (
      <ul className="space-y-0.5" data-info-list>
        {items.slice(0, max).map((it, i) => (
          <li key={`${it.name}-${i}`} className="min-w-0 truncate">
            <span className="text-ink">{it.name}</span>
            {it.meta && <span className="text-faint ml-2">{it.meta}</span>}
          </li>
        ))}
        {items.length > max && <li className="text-faint">+{items.length - max} more</li>}
      </ul>
    );
  const artistRows: Row[] = artist
    ? [
        [
          "Albums",
          rows(
            artist.albums.map((a) => ({
              name: a.title,
              meta: [a.year, a.format].filter(Boolean).join(FACT_SEP) || null,
            })),
            20,
          ),
        ],
        ["Tracks", artist.trackCount > 0 ? String(artist.trackCount) : null],
        [
          "Guest on",
          rows(
            artist.guestOn.map((g) => ({ name: g.title, meta: g.albumArtist ?? g.album ?? null })),
            8,
          ),
        ],
        [
          "Composed",
          artist.composed.length > 0
            ? `${artist.composed.length} ${artist.composed.length === 1 ? "track" : "tracks"}`
            : null,
        ],
        ["Genres", list(artist.genres, 8)],
        [
          "Active",
          artist.years
            ? artist.years[0] === artist.years[1]
              ? artist.years[0]
              : `${artist.years[0]}–${artist.years[1]}`
            : null,
        ],
      ]
    : [];

  // ---- the stream, as the streamer reports it (what is playing NOW)
  const stream_: Row[] = stream ? streamRows(stream) : [];

  // ---- source
  // What the index learned about this server (MediaServerProfile): how it was
  // crawled, and every reconciliation that changed something — so an odd
  // listing can be explained here instead of guessed at.
  const source: Row[] = sourceRows(node, serverName ?? null, serverProfile);

  // the caveat under the header: the target's own, else what is missing for an album or an
  // artist (they sat in the footer until the ‹ › took its place)
  const noteLine =
    note ??
    (kind === "album" && (!tracks || tracks.length === 0)
      ? "Open the album to see its tracks summed here."
      : kind === "artist" && !artist
        ? "No library index covers this artist yet."
        : null);

  const Icon = kind === "track" ? Music2 : kind === "artist" ? User : Disc3;
  const subtitle =
    kind === "track"
      ? [node.artist, node.album].filter(Boolean).join(" · ")
      : kind === "album"
        ? (node.artist ?? null)
        : null;

  return (
    <ModalShell
      open={open}
      onClose={close}
      label="Info"
      className="w-[640px] max-w-[92vw] max-h-[86vh] flex flex-col p-6"
      style={minHeight != null ? { minHeight } : undefined}
    >
      {/* THE WAY BACK (lib/infoSteps' history): the page behind this one, by name, where a
          browser's or a phone's back sits; ⌘← and Backspace do the same */}
      {backTo && (
        <button
          data-info-back
          onClick={() => infoBack()}
          data-tip={`Back (${IS_MAC ? "⌘" : "Alt+"}←)`}
          // no transition inside the frosted shell (S11): the shell fades as a whole
          className="tip-bottom tip-start -mt-2 mb-3 flex max-w-[60%] items-center gap-1 self-start text-[12.5px] text-dim hover:text-ink"
        >
          <ChevronLeft size={15} className="-ml-1 shrink-0" />
          <span className="truncate">{backTo.target.node.title}</span>
        </button>
      )}
      <div className="flex items-start gap-5" data-media-info>
        <div className="h-[128px] w-[128px] shrink-0 rounded-xl overflow-hidden ring-1 ring-edge bg-raised flex items-center justify-center">
          <ArtImage
            src={artSrc(node.artUrl, 128)}
            className="h-full w-full object-cover"
            fallback={<Icon size={40} strokeWidth={1} className="text-faint" />}
          />
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="microlabel">
            {stream
              ? `now playing · ${kind === "track" && /audioBroadcast/.test(node.upnpClass) ? "radio" : kind}`
              : kind === "track"
                ? trackLabel(node, placeCount)
                : kind}
          </div>
          <div className="font-display font-bold text-[20px] tracking-tight leading-tight mt-1 break-words">
            {node.title}
          </div>
          {kind === "track" && node.album && albumUp ? (
            // a row of two names that each shorten with an ellipsis: the album name is a button,
            // which a truncating line would drop whole for "…" (his Now Playing ⌘I, 2026-10-17)
            <div className="mt-0.5 flex min-w-0 text-[13px] text-dim" data-info-subtitle>
              {node.artist && <span className="max-w-[50%] shrink-0 truncate">{node.artist}</span>}
              {node.artist && <span className="shrink-0 whitespace-pre"> · </span>}
              <AlbumLink name={node.album} onGo={albumUp} truncate />
            </div>
          ) : (
            subtitle && <div className="text-[13px] text-dim mt-0.5 truncate">{subtitle}</div>
          )}
          {/* two registers (lib/mediaFacts): collection facts as prose, then
              the format TOKENS as chips with the DR chip closing the row —
              the clothes Now Playing taught the eye (user call, 2026-09-01) */}
          {factsLine && (
            <div className="mt-1.5 text-[12.5px] text-faint" data-info-facts>
              {factsLine}
            </div>
          )}
          {(chips.length > 0 || headerDr != null) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5" data-info-chips>
              {chips.map((b) => (
                <span key={b} className="badge">
                  {b}
                </span>
              ))}
              {headerDr != null && <DrChip dr={headerDr} />}
            </div>
          )}
        </div>
        {/* Found in a library index → lead there: an album lands on itself, a
            track on its album with the row flashed. Hidden for a bare stub
            (no serverUdn) and for artists (their page is this modal). */}
        {node.serverUdn && (kind === "track" || kind === "album") && (
          <button
            data-info-open-library
            onClick={() => {
              close();
              void openRefInLibrary(fromNode(node, node.serverUdn, serverName ?? null));
            }}
            className="shrink-0 self-start flex items-center gap-1.5 px-3 py-1.5 rounded-lg ring-1 ring-edge bg-panel/80 text-[12px] text-dim hover:text-ink hover:bg-veil"
          >
            <Library size={13} /> Open in Library
          </button>
        )}
        <CloseButton onClick={close} />
      </div>

      {kind === "track" && known.available && (
        <InfoWaveform
          state={known.state}
          onAnalyze={known.analyze}
          serverUdn={udn}
          objectId={node.id}
        />
      )}
      {/* An album's analysis coverage, and the sweep on offer — the same verb
          as the album menu and the track modal's button, one vocabulary. */}
      {kind === "album" && waveformsOn && udn && albumTotal > 0 && trackDrs != null && (
        <div className="mt-4" data-info-analysis>
          <div className="microlabel mb-1.5">analysis</div>
          {sweeping ? (
            <div className="text-[11.5px] text-faint motion-safe:animate-pulse">
              analyzing
              {progress != null && progress.total > 0 && ` ${progress.done}/${progress.total}`}…
            </div>
          ) : albumComplete ? (
            <div className="text-[12.5px] text-dim">
              All {albumTotal} tracks measured
              {drRange && drRange.min !== drRange.max
                ? `${FACT_SEP}DR${drRange.min} to DR${drRange.max} across tracks`
                : ""}
            </div>
          ) : (
            <div className="flex items-center gap-3">
              {albumKnown > 0 && (
                <span className="text-[11.5px] text-faint">
                  {albumKnown} of {albumTotal} tracks analyzed
                </span>
              )}
              <button
                data-info-analyze-album
                onClick={runAlbumAnalysis}
                // no transition inside the frosted shell (S11): the shell fades as a whole
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg ring-1 ring-edge bg-panel/80 text-[12px] text-dim hover:text-ink hover:bg-veil"
              >
                <AudioLines size={13} /> Analyze audio
              </button>
            </div>
          )}
        </div>
      )}

      {noteLine && (
        <div className="mt-3 text-[11.5px] text-faint" data-info-note>
          {noteLine}
        </div>
      )}
      <div className="mt-5 min-h-0 flex-1 overflow-y-auto pr-1" data-info-body>
        <InfoSections>
          {stream_.length > 0 && <Section title="Stream" rows={stream_} />}
          <Section title="Identity" rows={identity} />
          {orderedTracks && (
            <AlbumTrackList
              tracks={orderedTracks}
              albumArtist={node.artist ?? null}
              drs={trackDrMap}
              onOpen={openTrack}
            />
          )}
          {artistRows.length > 0 && <Section title="Library" rows={artistRows} />}
          {albumRows.length > 0 && <Section title="Album" rows={albumRows} />}
          {trackFormat.length > 0 && <Section title="Format" rows={trackFormat} />}
          <Section title="Source" rows={source} />
        </InfoSections>
      </div>

      <div ref={footRef} className="mt-5 flex items-center justify-between">
        {/* ‹ › where Music puts them; the format line that sat here repeated the chips above */}
        <div className="flex items-center gap-1.5" data-info-steps>
          {stepping && (
            <>
              <StepButton dir={-1} enabled={canStep(infoList, -1)} />
              <StepButton dir={1} enabled={canStep(infoList, 1)} />
            </>
          )}
        </div>
        <button
          onClick={copy}
          data-info-copy
          className="flex items-center gap-1.5 rounded-full ring-1 ring-edge bg-raised/70 px-3 py-1.5 text-[12px] text-dim hover:text-ink hover:ring-edge2"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? "Copied" : "Copy as JSON"}
        </button>
      </div>
    </ModalShell>
  );
}

/** One of the footer's ‹ ›: dim and inert at either end of the list, never wrapping. */
/** An album name in a track's Info that opens the album's Info (the subtitle and the Album row). */
function AlbumLink({
  name,
  onGo,
  truncate = false,
}: {
  name: string;
  onGo(): void;
  /** In a line of its own: shortens with an ellipsis inside the button (the tooltip stays on
   *  the button, outside the clipping). */
  truncate?: boolean;
}): React.JSX.Element {
  return (
    <button
      data-info-album-link
      onClick={onGo}
      data-tip="Show the album's Info"
      // no transition inside the frosted shell (S11): the shell fades as a whole
      className={cx(
        "tip-bottom text-left hover:text-ink hover:underline underline-offset-2",
        truncate && "min-w-0 shrink",
      )}
    >
      {truncate ? <span className="block truncate">{name}</span> : name}
    </button>
  );
}

/** An album's tracks in its Info, in the album's order: number, title (and the performer when
 *  not the album's), the DR when measured, the length; a row opens that track's Info. Disc
 *  headings on an album of several. */
function AlbumTrackList({
  tracks,
  albumArtist,
  drs,
  onOpen,
}: {
  tracks: MediaNode[];
  albumArtist: string | null;
  drs: Record<string, number> | null;
  onOpen(t: MediaNode): void;
}): React.JSX.Element {
  const groups = discGroups(tracks);
  const lc = (v: string | null | undefined): string => (v ?? "").trim().toLowerCase();
  return (
    <div data-info-section="tracks" className="col-span-full">
      <div className="microlabel mb-1.5">Tracks</div>
      {groups.map((g, gi) => (
        <div key={g.disc ?? 0} className={gi > 0 ? "mt-3" : undefined}>
          {g.disc != null && (
            <div className="mb-1 text-[11.5px] text-faint" data-info-disc={g.disc}>
              Disc {g.disc}
            </div>
          )}
          {g.tracks.map((t) => {
            const dr = drs?.[audioAnalysisKey(t)] ?? null;
            const other = t.artist && albumArtist && lc(t.artist) !== lc(albumArtist);
            return (
              <button
                key={t.id}
                data-info-track={t.title}
                onClick={() => onOpen(t)}
                aria-label={`Info for ${t.title}`}
                // no transition inside the frosted shell (S11): the shell fades as a whole
                className="group -mx-2 grid w-[calc(100%+1rem)] grid-cols-[1.5rem_minmax(0,1fr)_auto_2.75rem_0.875rem] items-center gap-2.5 rounded-lg px-2 py-1 text-left text-[12.5px] hover:bg-veil2"
              >
                <span className="text-right tabular-nums text-faint">{trackPosition(t) ?? ""}</span>
                <span className="min-w-0 truncate text-ink">
                  {t.title}
                  {other && <span className="text-faint"> · {t.artist}</span>}
                </span>
                <span className="flex">{dr != null && <DrBadge dr={dr} className="" />}</span>
                <span className="text-right tabular-nums text-faint">
                  {t.durationSecs != null ? fmtTime(t.durationSecs) : ""}
                </span>
                <ChevronRight size={13} className="text-transparent group-hover:text-dim" />
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function StepButton({ dir, enabled }: { dir: -1 | 1; enabled: boolean }): React.JSX.Element {
  const label = dir < 0 ? "Previous track" : "Next track";
  return (
    <button
      onClick={() => void stepInfo(dir)}
      disabled={!enabled}
      data-info-step={dir < 0 ? "prev" : "next"}
      data-tip={enabled ? `${label} (${dir < 0 ? "←" : "→"})` : undefined}
      aria-label={label}
      // no transition inside the frosted shell (S11): the shell fades as a whole
      className={cx(
        "tip-top flex h-8 w-8 items-center justify-center rounded-full ring-1 ring-edge bg-raised/70",
        enabled
          ? "text-dim hover:text-ink hover:ring-edge2"
          : "text-faint opacity-40 cursor-default",
      )}
    >
      {dir < 0 ? <ChevronLeft size={15} /> : <ChevronRight size={15} />}
    </button>
  );
}
