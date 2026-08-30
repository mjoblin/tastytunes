import { useEffect, useRef, useState } from "react";
import {
  Activity,
  AudioLines,
  Check,
  Copy,
  Disc3,
  ExternalLink,
  RotateCw,
  UserRound,
  X,
} from "lucide-react";
import type { AlbumInfo, ArtistInfo, MediaInfoTarget, TrackCredit, TrackInfo } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { deriveNowPlaying, cx } from "@/lib/format";
import { nowPlayingInfoTarget } from "@/lib/mediaInfo";
import { usePanelWidth } from "@/hooks/usePanelWidth";
import { PanelResizeHandle } from "@/components/controls/PanelResizeHandle";
import { Segmented } from "@/components/controls/Segmented";
import { HeaderChip } from "@/components/chrome/Chrome";
import { Section, sourceRows, streamRows, trackFormatRows } from "@/components/media/InfoRows";

type Status = "loading" | "ready" | "none";
type Tab = "artist" | "album" | "track" | "stream";

/**
 * A track change while the Track tab is open waits this long before asking
 * MusicBrainz — skipping through a queue must not stack searches behind the
 * shared 1 rps gate (they would starve the other tabs too). Opening the tab
 * is intent and fetches immediately.
 */
const TRACK_SETTLE_MS = 2000;

/**
 * Context drawer on Now Playing — Artist | Album | Track | Stream tabs.
 * Artist: a MusicBrainz-matched artist with a Wikipedia summary. Album:
 * release-group facts (year, type, label, genre tags, release-level credits)
 * plus a Wikipedia summary when one is linked. Track: who is actually ON the
 * playing recording — performers, production, writing — from recording-level
 * relationships (the album tab deliberately stays release-level; per-track is
 * the budget-safe place for this depth). Stream: device truth — what the
 * streamer reports about what is playing, plus the library's file facts for
 * local media; it shares its row builders with the Info modal (InfoRows) and
 * is why the drawer opens for EVERY source, radio and cast included. Same
 * shell as the lyrics drawer; the two drawers are mutually exclusive (the
 * store's setters enforce it). Each tab fetches only while active — the disk
 * cache makes revisits instant, and the Stream tab's lookup is local.
 */
export function ArtistPanel({ className }: { className?: string }): React.JSX.Element {
  const playState = useStore((s) => s.playState);
  const nowPlaying = useStore((s) => s.nowPlaying);
  const setArtistOpen = useStore((s) => s.setArtistOpen);
  const contextTab = useStore((s) => s.contextTab);
  const setContextTab = useStore((s) => s.setContextTab);
  // The MB-backed tabs (Artist | Album | Track) exist only while the context
  // setting is on; the Stream tab is device truth and always offered — it is
  // why the drawer opens for radio and cast sources too.
  const mbEnabled = useStore((s) => s.settings.artistInfo);

  const meta = deriveNowPlaying(playState, nowPlaying);
  const artist = meta.isRadio || !mbEnabled ? null : meta.subtitle;
  const album = meta.isRadio || !mbEnabled ? null : meta.album;
  const title = meta.isRadio || !mbEnabled ? null : meta.title;
  const duration = meta.isRadio ? null : (playState?.metadata?.duration ?? null);
  const trackable = Boolean(artist && title);
  const fallback: Tab = artist ? "artist" : "stream";
  const tab: Tab =
    (contextTab === "artist" && !artist) ||
    (contextTab === "album" && !album) ||
    (contextTab === "track" && !trackable)
      ? fallback
      : contextTab;
  const { width, dragging, snapped, handleProps } = usePanelWidth();

  const [artistStatus, setArtistStatus] = useState<Status>("loading");
  const [artistInfo, setArtistInfo] = useState<ArtistInfo | null>(null);
  const [albumStatus, setAlbumStatus] = useState<Status>("loading");
  const [albumInfo, setAlbumInfo] = useState<AlbumInfo | null>(null);
  const [trackStatus, setTrackStatus] = useState<Status>("loading");
  const [trackInfo, setTrackInfo] = useState<TrackInfo | null>(null);
  const [streamTarget, setStreamTarget] = useState<MediaInfoTarget | null>(null);
  const [streamCopied, setStreamCopied] = useState(false);
  const [fetchNonce, setFetchNonce] = useState(0);
  const forceRef = useRef(false);
  const prevTrackKeyRef = useRef<string | null>(null);
  // The stream effect keys on the track identity, not the playState object —
  // play_state pushes every position tick and the tab must not re-derive per
  // second. The refs hand the effect the freshest push when it does run.
  const playStateRef = useRef(playState);
  playStateRef.current = playState;
  const nowPlayingRef = useRef(nowPlaying);
  nowPlayingRef.current = nowPlaying;
  const streamKey = `${meta.title ?? ""}|${meta.subtitle ?? ""}|${meta.album ?? ""}|${playState?.metadata?.station ?? ""}`;

  useEffect(() => {
    if (tab !== "artist") return;
    if (!artist) {
      setArtistStatus("none");
      setArtistInfo(null);
      return;
    }
    const force = forceRef.current;
    forceRef.current = false;
    let stale = false;
    setArtistStatus("loading");
    void tt
      .fetchArtistInfo(artist, force)
      .then((res) => {
        if (stale) return;
        setArtistInfo(res);
        setArtistStatus(res ? "ready" : "none");
      })
      .catch(() => {
        if (!stale) setArtistStatus("none");
      });
    return () => {
      stale = true;
    };
  }, [tab, artist, fetchNonce]);

  useEffect(() => {
    if (tab !== "album") return;
    if (!artist || !album) {
      setAlbumStatus("none");
      setAlbumInfo(null);
      return;
    }
    const force = forceRef.current;
    forceRef.current = false;
    let stale = false;
    setAlbumStatus("loading");
    void tt
      .fetchAlbumInfo(artist, album, force)
      .then((res) => {
        if (stale) return;
        setAlbumInfo(res);
        setAlbumStatus(res ? "ready" : "none");
      })
      .catch(() => {
        if (!stale) setAlbumStatus("none");
      });
    return () => {
      stale = true;
    };
  }, [tab, artist, album, fetchNonce]);

  useEffect(() => {
    if (tab !== "track") {
      // Re-activating the tab fetches immediately even if the track moved
      // while it was closed — opening it is intent, so no settle then.
      prevTrackKeyRef.current = null;
      return;
    }
    if (!artist || !title) {
      setTrackStatus("none");
      setTrackInfo(null);
      return;
    }
    const trackKey = `${artist}|${album ?? ""}|${title}`;
    const settle =
      prevTrackKeyRef.current !== null && prevTrackKeyRef.current !== trackKey
        ? TRACK_SETTLE_MS
        : 0;
    prevTrackKeyRef.current = trackKey;
    const force = forceRef.current;
    forceRef.current = false;
    let stale = false;
    setTrackStatus("loading");
    const timer = window.setTimeout(() => {
      void tt
        .fetchTrackInfo({ artist, title, album: album ?? null, duration }, force)
        .then((res) => {
          if (stale) return;
          setTrackInfo(res);
          setTrackStatus(res ? "ready" : "none");
        })
        .catch(() => {
          if (!stale) setTrackStatus("none");
        });
    }, settle);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [tab, artist, title, album, duration, fetchNonce]);

  useEffect(() => {
    if (tab !== "stream") return;
    forceRef.current = false;
    const built = nowPlayingInfoTarget(playStateRef.current, nowPlayingRef.current);
    if (!built) {
      setStreamTarget(null);
      return;
    }
    // Stream facts land at once; for local media the library node joins when
    // the (local, unmetered) content lookup answers — the modal's pattern.
    setStreamTarget(built.target);
    if (!built.localQuery) return;
    let stale = false;
    void tt
      .mediaNodeInfo(built.localQuery)
      .then((found) => {
        if (stale || !found) return;
        setStreamTarget({
          ...found,
          stream: built.target.stream,
          node: { ...found.node, artUrl: found.node.artUrl ?? built.target.node.artUrl },
        });
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [tab, streamKey, fetchNonce]);

  const refresh = (): void => {
    forceRef.current = true;
    setFetchNonce((n) => n + 1);
  };

  const status: Status =
    tab === "artist"
      ? artistStatus
      : tab === "album"
        ? albumStatus
        : tab === "track"
          ? trackStatus
          : streamTarget
            ? "ready"
            : "none";
  const TabIcon =
    tab === "artist"
      ? UserRound
      : tab === "album"
        ? Disc3
        : tab === "track"
          ? AudioLines
          : Activity;
  const facts =
    albumInfo == null
      ? ""
      : [albumInfo.year, albumInfo.type, albumInfo.label].filter(Boolean).join(" · ");
  const wikipediaUrl =
    tab === "artist" ? artistInfo?.wikipediaUrl : tab === "album" ? albumInfo?.wikipediaUrl : null;
  const musicbrainzUrl =
    tab === "artist"
      ? artistInfo?.musicbrainzUrl
      : tab === "album"
        ? albumInfo?.musicbrainzUrl
        : tab === "track"
          ? trackInfo?.musicbrainzUrl
          : null;
  const trackGroups: Array<{ label: string; credits: TrackCredit[] }> =
    trackInfo == null
      ? []
      : [
          { label: "performers", credits: trackInfo.performers },
          { label: "production", credits: trackInfo.production },
          { label: "writing", credits: trackInfo.writing },
        ].filter((g) => g.credits.length > 0);

  return (
    <aside
      style={{ width }}
      className={cx(
        "no-drag absolute inset-y-0 right-0 z-10 max-w-[60%] flex flex-col bg-panel/60 backdrop-blur-md border-l border-edge",
        className,
      )}
    >
      <PanelResizeHandle dragging={dragging} snapped={snapped} handleProps={handleProps} />
      <div className="flex items-center justify-between px-6 pt-5 pb-3">
        <div className="microlabel text-ink/80 flex items-center gap-2">
          <TabIcon size={13} />
          {tab}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={refresh}
            disabled={status === "loading"}
            aria-label="Refresh details"
            data-tip="Refresh details"
            className="tip-bottom tip-end p-1.5 rounded-full text-dim hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all disabled:opacity-40 disabled:pointer-events-none"
          >
            <RotateCw size={13} />
          </button>
          <button
            onClick={() => setArtistOpen(false)}
            aria-label="Close context panel"
            className="p-1.5 rounded-full text-dim hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {artist && (
        <div className="px-6 pb-3">
          <Segmented<Tab>
            className="w-fit"
            value={tab}
            onChange={setContextTab}
            options={[
              { value: "artist", label: "Artist" },
              ...(album ? [{ value: "album" as Tab, label: "Album" }] : []),
              ...(trackable ? [{ value: "track" as Tab, label: "Track" }] : []),
              { value: "stream", label: "Stream" },
            ]}
          />
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-4">
        {status === "loading" && (
          <div className="text-[13px] text-dim pt-2 motion-safe:animate-pulse">
            Retrieving {tab} details…
          </div>
        )}

        {status === "none" && (
          <div className="text-[13px] text-faint pt-2">
            {tab === "artist"
              ? artist
                ? `Nothing found for ${artist}.`
                : "Artist info needs track metadata — not available for this source."
              : tab === "album"
                ? album
                  ? `Nothing found for ${album}.`
                  : "Album info needs track metadata — not available for this source."
                : tab === "track"
                  ? title
                    ? `Nothing found for ${title}.`
                    : "Track info needs track metadata — not available for this source."
                  : "Nothing is playing."}
          </div>
        )}

        {tab === "artist" && artistStatus === "ready" && artistInfo && (
          <div className="space-y-3 py-1">
            <div className="font-display font-bold text-[19px] tracking-tight">
              {artistInfo.name}
            </div>
            {artistInfo.summary ? (
              <p className="text-[13.5px] leading-relaxed text-dim whitespace-pre-wrap">
                {artistInfo.summary}
              </p>
            ) : (
              <p className="text-[13px] text-faint">
                Matched on MusicBrainz, but no Wikipedia summary is linked.
              </p>
            )}
          </div>
        )}

        {tab === "album" && albumStatus === "ready" && albumInfo && (
          <div className="space-y-3 py-1" data-album-tab>
            <div>
              <div className="font-display font-bold text-[19px] tracking-tight">
                {albumInfo.title}
              </div>
              {facts && <div className="text-[12.5px] text-dim pt-1">{facts}</div>}
            </div>
            {albumInfo.genres.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {albumInfo.genres.map((g) => (
                  <span
                    key={g}
                    className="microlabel px-2 py-0.5 rounded-full ring-1 ring-edge bg-panel/70 text-faint"
                  >
                    {g}
                  </span>
                ))}
              </div>
            )}
            {albumInfo.summary ? (
              <p className="text-[13.5px] leading-relaxed text-dim whitespace-pre-wrap">
                {albumInfo.summary}
              </p>
            ) : (
              <p className="text-[13px] text-faint">
                Matched on MusicBrainz, but no Wikipedia summary is linked.
              </p>
            )}
            {albumInfo.credits.length > 0 && (
              <div className="space-y-1 pt-1">
                <div className="microlabel text-ink/80">credits</div>
                {albumInfo.credits.map((c) => (
                  <div key={`${c.role}|${c.name}`} className="text-[13px]">
                    <span className="text-faint">{c.role}</span>{" "}
                    <span className="text-dim">{c.name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === "stream" && streamTarget && (
          <div className="space-y-5 py-1" data-stream-tab>
            <Section
              title="Stream"
              rows={streamTarget.stream ? streamRows(streamTarget.stream) : []}
            />
            <Section title="Format" rows={trackFormatRows(streamTarget.node)} />
            <Section
              title="Source"
              rows={sourceRows(
                streamTarget.node,
                streamTarget.serverName ?? null,
                streamTarget.serverProfile,
              )}
            />
          </div>
        )}

        {tab === "track" && trackStatus === "ready" && trackInfo && (
          <div className="space-y-3 py-1" data-track-tab>
            <div className="font-display font-bold text-[19px] tracking-tight">
              {trackInfo.title}
            </div>
            {trackGroups.length === 0 ? (
              <p className="text-[13px] text-faint">
                Matched on MusicBrainz, but no personnel are recorded for this track.
              </p>
            ) : (
              trackGroups.map((g) => (
                <div key={g.label} className="space-y-1 pt-1">
                  <div className="microlabel text-ink/80">{g.label}</div>
                  {g.credits.map((c) => (
                    <div key={`${c.role}|${c.name}`} className="text-[13px]">
                      <span className="text-faint">{c.role}</span>{" "}
                      <span className="text-dim">{c.name}</span>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {status === "ready" && (wikipediaUrl || musicbrainzUrl || tab === "stream") && (
        <div className="px-6 py-3 border-t border-edge flex flex-wrap items-center gap-x-4 gap-y-2">
          {tab === "stream" && streamTarget && (
            <HeaderChip
              onClick={() => {
                void navigator.clipboard
                  .writeText(
                    JSON.stringify(
                      { node: streamTarget.node, stream: streamTarget.stream },
                      null,
                      2,
                    ),
                  )
                  .then(() => {
                    setStreamCopied(true);
                    setTimeout(() => setStreamCopied(false), 1500);
                  });
              }}
              className="microlabel flex items-center gap-1.5 px-2.5 py-1.5 motion-safe:active:scale-90"
            >
              {streamCopied ? <Check size={10} /> : <Copy size={10} />}
              {streamCopied ? "copied" : "copy as json"}
            </HeaderChip>
          )}
          {wikipediaUrl && (
            <HeaderChip
              onClick={() => void tt.openExternal(wikipediaUrl)}
              className="microlabel flex items-center gap-1.5 px-2.5 py-1.5 motion-safe:active:scale-90"
            >
              wikipedia <ExternalLink size={10} />
            </HeaderChip>
          )}
          {musicbrainzUrl && (
            <HeaderChip
              onClick={() => void tt.openExternal(musicbrainzUrl)}
              className="microlabel flex items-center gap-1.5 px-2.5 py-1.5 motion-safe:active:scale-90"
            >
              musicbrainz <ExternalLink size={10} />
            </HeaderChip>
          )}
        </div>
      )}
    </aside>
  );
}
