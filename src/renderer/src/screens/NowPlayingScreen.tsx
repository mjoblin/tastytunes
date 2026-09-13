import { useEffect, useRef, useState } from "react";
import {
  Captions,
  Disc3,
  Heart,
  ListOrdered,
  Maximize2,
  MicVocal,
  Info,
  RadioTower,
  Sparkles,
} from "lucide-react";
import { useStore } from "@/store";
import { activeSourceId, cx, deriveNowPlaying } from "@/lib/format";
import { playingQueueEntry } from "@/lib/playingEntry";
import { fromQueueItem } from "@/lib/mediaRef";
import { NameLink } from "@/components/media/NameLine";
import { useSettledSnapshot } from "@/hooks/useSettledSnapshot";
import { useNowPlayingHeart } from "@/hooks/useNowPlayingHeart";
import { useDecodedArt } from "@/hooks/useDecodedArt";
import { AddToPlaylistPanel } from "@/components/overlays/AddToPlaylistPanel";
import { SignalLamp } from "@/components/device/SignalLamp";
import { ArtImage } from "@/components/media/ArtImage";
import { useBestArt } from "@/lib/bestArt";
import { useFadePresence } from "@/hooks/useFadePresence";
import { LyricsPanel } from "@/components/overlays/LyricsPanel";
import { LyricLine } from "@/components/playback/LyricLine";
import { EmptyState } from "@/components/chrome/EmptyState";
import { ResumeCard } from "@/components/playback/ResumeCard";
import { ArtistPanel } from "@/components/overlays/ArtistPanel";
import { NowPlayingWaveform, PlayingDrChip, usePlayingAnalysis } from "@/components/media/Waveform";
import { SceneCanvas } from "@/components/display/SceneCanvas";
import { ScenePicker } from "@/components/display/ScenePicker";
import { useSceneFeed } from "@/components/display/feed";
import { isAbstract, sceneDef } from "@/components/display/scenes";
import { useShuffledScene } from "@/components/display/useShuffledScene";
import type { SceneId } from "@/components/display/scenes/types";

const ALIGN_H = { left: "justify-start", center: "justify-center", right: "justify-end" } as const;
/** How long the playing track's analysis must stay absent before the scene tile yields to
 *  the art: longer than a skip's identity hand-off, shorter than a wait would feel. */
const SCENE_ABSENT_MS = 1500;
const ALIGN_V = { top: "items-start", center: "items-center", bottom: "items-end" } as const;

export function NowPlayingScreen(): React.JSX.Element {
  const playState = useStore((s) => s.playState);
  const saveSettings = useStore((s) => s.saveSettings);
  const nowPlaying = useStore((s) => s.nowPlaying);
  const queue = useStore((s) => s.queue);
  const zoneState = useStore((s) => s.zoneState);
  const effectivePlayId = useStore((s) => s.effectivePlayId);
  const displayMode = useStore((s) => s.displayMode);
  const setDisplayMode = useStore((s) => s.setDisplayMode);
  const lyricsOpen = useStore((s) => s.lyricsOpen);
  const setLyricsOpen = useStore((s) => s.setLyricsOpen);
  const artistOpen = useStore((s) => s.artistOpen);
  const setArtistOpen = useStore((s) => s.setArtistOpen);
  const {
    nowPlayingAlignH,
    nowPlayingAlignV,
    lyrics: lyricsEnabled,
    lyricsLine,
    nowPlayingScene,
    nowPlayingSceneWords,
  } = useStore((s) => s.settings);
  const meta = deriveNowPlaying(playState, nowPlaying);
  // THE TILE'S SCENE (2026-09-12): the hero's art box shows a display-mode
  // scene, chosen from display mode's own picker off a chip on the tile, and
  // remembered apart from the fullscreen view's choice (the user: "separate").
  // Sleeve is the art and the default, so the screen looks as it always did
  // until asked. A scene only runs while the playing track has an analysis to
  // drive it (a scene fed nothing drifts on sines, which reads as fake beside
  // real controls) and never for radio: the art stands in. The tile is `mini`
  // (pixel ratio 1, no cathode finish), the feed its own.
  const { shuffled: tileShuffled, active: tileActive } = useShuffledScene(nowPlayingScene, meta);
  const [scenesOpen, setScenesOpen] = useState(false);
  const chipOn = !meta.isRadio && meta.title != null;
  const tileStage: SceneId | null = chipOn && isAbstract(tileActive) ? tileActive : null;
  const sceneFeed = useSceneFeed(tileStage != null || scenesOpen);
  const sceneAnalysis = usePlayingAnalysis(tileStage != null);
  // THE GATE HOLDS ACROSS A TRACK CHANGE: on a skip the playing track's identity is resolved
  // again and the analysis hook passes through absent, then loading, before the new record
  // arrives; a gate that read those literally dropped the tile to the art for that moment
  // on every skip (the user, 2026-09-12: "flashes the album art"). A record turns the scene
  // on at once; absence turns it off only once it has stayed absent for a beat, longer than
  // the hand-off, so the pass-through never shows and the canvas is never torn down for it
  const [sceneReady, setSceneReady] = useState(false);
  useEffect(() => {
    if (sceneAnalysis === "loading") return;
    if (sceneAnalysis != null) {
      setSceneReady(true);
      return;
    }
    const t = setTimeout(() => setSceneReady(false), SCENE_ABSENT_MS);
    return () => clearTimeout(t);
  }, [sceneAnalysis]);
  const sceneOn = tileStage != null && sceneReady;
  // THE WORDS ARE THE TILE'S OWN CALL (the user, 2026-09-12: a switch in the picker "feels a
  // bit hidden... lyrics are important"): a toggle on the tile, bottom left, the mirror of
  // the header's lyric-line toggle. A scene that is its words (Type, Terminal) draws them
  // regardless and the toggle is disabled there
  const tileDef = tileStage ? sceneDef(tileStage) : null;
  const wordsForced = tileDef?.essentialWords === true;
  const tileWords = wordsForced || nowPlayingSceneWords;
  // Escape closes the picker, as does a press anywhere but the picker or its
  // chip: the app's chrome included, which a catcher inside this screen
  // could not reach (the user hit it on the nav and the controls)
  useEffect(() => {
    if (!scenesOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setScenesOpen(false);
    };
    const onDown = (e: PointerEvent): void => {
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest("[data-display-scenes],[data-now-playing-scene-chip]")) return;
      setScenesOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [scenesOpen]);
  // NAMES NAVIGATE (2026-09-02, the rule reaches Now Playing): for a LIBRARY
  // track — the media player source, a queue entry resolving through the
  // settled playing id — the artist and album lines are links. Identity is
  // the QUEUE ENTRY's (the readout is the file tags, which renaming servers
  // and a lying pointer can both disagree with); the text shown stays the
  // settled snapshot's. Display mode keeps the hero quiet; radio, AirPlay and
  // the other sources show plain text.
  const playingEntry = playingQueueEntry(queue, playState, effectivePlayId);
  const linkable =
    !displayMode &&
    !meta.isRadio &&
    playingEntry != null &&
    activeSourceId(zoneState, nowPlaying) === "MEDIA_PLAYER";
  const entryRef = linkable && playingEntry ? fromQueueItem(playingEntry) : null;
  const entryArtist = linkable ? (playingEntry?.metadata?.artist ?? null) : null;

  // Title/artist/album/badges render from a SETTLED snapshot and fade as one
  // group on track change (same idea as display mode): fade out, wait for the
  // metadata to settle, then adopt + fade the new track in — so the gap never
  // flashes intermediate/empty states. The album art crossfades independently.
  //
  // The signature is the TRACK'S IDENTITY only. Badges ride along in the
  // snapshot (they swap with the group) but must never drive the settle: the
  // bitrate badge can tick on its own, and a signature that ticks re-arms the
  // timer forever — which held the whole block at opacity 0 for as long as the
  // ticking lasted. Queue position is deliberately NOT snapshotted: it moves
  // for reasons that have nothing to do with the track (adding, removing or
  // reordering the queue), so it renders live and merely fades with the group.
  const liveTrackSig = `${meta.title ?? ""}␟${meta.subtitle ?? ""}␟${meta.album ?? ""}`;
  const { shown: shownTrack, visible: trackVisible } = useSettledSnapshot(liveTrackSig, () => ({
    title: meta.title,
    subtitle: meta.subtitle,
    album: meta.album,
    badges: meta.badges,
  }));
  // Right placement mirrors the pair: art anchors the right edge, text grows leftward.
  const mirrored = nowPlayingAlignH === "right";

  // Lyrics need real track metadata — hidden for radio and title-only sources.
  const lyricsAvailable = lyricsEnabled && !meta.isRadio && !!meta.title && !!meta.subtitle;
  // The About drawer opens for EVERY source — its Stream tab is device truth
  // and needs only something loaded; the MB tabs gate themselves inside.
  const aboutAvailable =
    (meta.title != null && meta.title !== "") || playState?.metadata?.station != null;
  // Quick fade on open/close — see useFadePresence for why 140ms.
  const lyricsFade = useFadePresence(lyricsAvailable && lyricsOpen);
  const artistFade = useFadePresence(aboutAvailable && artistOpen);

  // The heart: content-only favoriting of whatever is playing. Shared with the
  // tray panel — the track/station/last-station asymmetry lives in the hook.
  const md = playState?.metadata;
  const {
    active: heartActive,
    available: heartAvailable,
    toggle: toggleHeart,
  } = useNowPlayingHeart();

  const toggleLyricLine = async (): Promise<void> => {
    await saveSettings({ lyricsLine: !lyricsLine });
  };

  const sourceName = nowPlaying?.source?.name ?? null;
  const state = playState?.state;
  // The tile renders the last DECODED cover (see useDecodedArt) — a hard swap
  // between two real images, never a swap to an empty box mid-download.
  // the best art for the hero: the server's unless it is small and the file
  // carries a bigger picture (lib/bestArt), read for local media only; every
  // titled track keeps its query so a DEAD streamer URL (an AirPlay cover's,
  // 2026-09-06) can fall back to the log's own copy
  const heroQuery =
    !meta.isRadio && meta.title
      ? { title: meta.title, artist: meta.subtitle ?? null, album: meta.album ?? null }
      : null;
  const heroArt = useBestArt(
    meta.artUrl,
    heroQuery,
    activeSourceId(zoneState, nowPlaying) === "MEDIA_PLAYER",
  );
  const { art: tileArt } = useDecodedArt(heroArt);
  // Live, not snapshotted — the queue moves independently of the track.
  const queueIndex = playState?.queue_index;
  const queueLength = playState?.queue_length;

  // Only surface "buffering" once it has persisted a beat — brief buffers on a
  // seek or track change shouldn't flash a label. Other states show at once.
  //
  // 800ms, not 2s (user call 2026-07-24): long enough to swallow seek and
  // track-change blips, short enough that a genuinely slow radio start gets
  // named while you're still wondering. The playback bar's `busy` LED stays
  // INSTANT on purpose — the two do different jobs. The LED says "something is
  // happening", which is ambient and belongs immediately; the label NAMES a
  // state, which is a statement and earns a threshold.
  const [bufferingSettled, setBufferingSettled] = useState(false);
  useEffect(() => {
    if (state !== "buffering") {
      setBufferingSettled(false);
      return;
    }
    const t = setTimeout(() => setBufferingSettled(true), 800);
    return () => clearTimeout(t);
  }, [state]);

  // Adding what's playing is the other half of "add from wherever you see
  // music". Tracks only — a radio stream can't hold a position in an ordered
  // list, so the button simply isn't offered for one.
  const playlistBtn = useRef<HTMLButtonElement | null>(null);
  const [playlistAt, setPlaylistAt] = useState<{ x: number; y: number } | null>(null);
  const playlistAvailable = !meta.isRadio && !!meta.title;

  const empty = !meta.title && !meta.subtitle;
  /** Every header button hides on this pair; naming it once also stopped the two
   *  lyrics buttons from spelling the same condition in two different orders. */
  const drawersClosed = !lyricsOpen && !artistOpen;

  // Titleless top band: preserves the header's vertical rhythm (and houses the
  // display-mode button) so the art/text sit where they did with a title.
  const header = (
    // relative z-20 keeps the header's buttons clickable above the drawers
    // (z-10) — but pointer-events-none on the strip itself, restored per
    // button, so the empty band never eats the drawer ✕ beneath it. Window
    // dragging is unaffected: app-region is a native hit-test, not CSS.
    <header className="drag-region relative z-20 pointer-events-none flex items-center justify-end gap-6 px-8 pt-8 pb-4 min-h-[83px]">
      {/* THREE GROUPS, told apart by gaps (two groups user call 2026-07-24;
          the third named 2026-08-30 when the Info button folded into the About
          drawer's Stream tab). The strip's buttons do three different jobs:
          the first pair WRITES to stored collections, the middle pair opens a
          SIDE PANEL about the music, and the last pair changes what THIS
          SCREEN shows (the lyric line, display mode). Grouped by proximity
          rather than a hairline rule — proximity is already the app's grouping
          device (see the row-action clusters), a rule would be the loudest
          thing in a strip meant to sit quietly over album art, and since most
          buttons here are conditional a divider would need its own logic to
          avoid floating with nothing left to separate. A gap between groups
          just collapses.
          gap-6 here against the Queue header's gap-4 on purpose: these are bare
          icons and those are ringed chips, which already separate themselves.
          The aim is equal PERCEIVED separation, not equal pixels.
          While a drawer is open the header goes quiet entirely — the panel's
          own ✕ (or Escape) is the one way out. */}
      {drawersClosed && (playlistAvailable || heartAvailable) && (
        <div data-np-group="write" className="flex items-center">
          {playlistAvailable && (
            <button
              ref={playlistBtn}
              onClick={() => {
                const r = playlistBtn.current?.getBoundingClientRect();
                setPlaylistAt({ x: r ? r.left : 0, y: r ? r.bottom + 6 : 0 });
              }}
              data-tip="Add to playlist"
              aria-label="Add to playlist"
              className="no-drag pointer-events-auto tip-bottom tip-end p-2 rounded-full text-faint hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all"
            >
              <ListOrdered size={18} />
            </button>
          )}
          {heartAvailable && (
            <button
              onClick={toggleHeart}
              data-tip={heartActive ? "Remove from favorites" : "Add to favorites"}
              aria-label={heartActive ? "Remove from favorites" : "Add to favorites"}
              data-np-heart={heartActive ? "on" : "off"}
              className={cx(
                "no-drag pointer-events-auto tip-bottom tip-end p-2 rounded-full hover:bg-veil2 motion-safe:active:scale-90 transition-all",
                heartActive ? "text-gold hover:text-ink" : "text-faint hover:text-ink",
              )}
            >
              <Heart size={16} fill={heartActive ? "currentColor" : "none"} />
            </button>
          )}
        </div>
      )}
      {drawersClosed && (lyricsAvailable || aboutAvailable) && (
        <div data-np-group="panels" className="flex items-center">
          {lyricsAvailable && (
            <button
              onClick={() => setLyricsOpen(true)}
              data-tip="Lyrics"
              aria-label="Lyrics"
              className="no-drag pointer-events-auto tip-bottom tip-end p-2 rounded-full text-faint hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all"
            >
              <MicVocal size={16} />
            </button>
          )}
          {aboutAvailable && (
            <button
              onClick={() => setArtistOpen(true)}
              data-tip="About the music"
              aria-label="About the music"
              className="no-drag pointer-events-auto tip-bottom tip-end p-2 rounded-full text-faint hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all"
            >
              <Info size={16} />
            </button>
          )}
        </div>
      )}
      {drawersClosed && (
        <div data-np-group="screen" className="flex items-center">
          {lyricsAvailable && (
            <button
              onClick={() => void toggleLyricLine()}
              data-tip={lyricsLine ? "Hide current lyric line" : "Show current lyric line"}
              aria-label="Current lyric line"
              className={cx(
                "no-drag pointer-events-auto tip-bottom tip-end p-2 rounded-full hover:bg-veil2 motion-safe:active:scale-90 transition-all",
                lyricsLine ? "text-gold hover:text-ink" : "text-faint hover:text-ink",
              )}
            >
              <Captions size={16} />
            </button>
          )}
          <button
            onClick={() => setDisplayMode(true)}
            data-tip="Full-screen display mode (F)"
            aria-label="Full-screen display mode (F)"
            className="no-drag pointer-events-auto tip-bottom tip-end p-2 rounded-full text-faint hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all"
          >
            <Maximize2 size={16} />
          </button>
        </div>
      )}
    </header>
  );

  if (empty) {
    return (
      <div className="h-full flex flex-col">
        {header}
        <EmptyState
          icon={Disc3}
          title="Nothing playing"
          caption="Start playback from a queue, recall a preset, or stream to the device from another app."
        >
          {/* the listening record's offer (0.8.0): an album left unfinished */}
          <ResumeCard />
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="relative h-full overflow-hidden flex flex-col">
      {scenesOpen && (
        <ScenePicker
          feed={sceneFeed}
          current={nowPlayingScene}
          shuffled={tileShuffled}
          art={tileArt ?? null}
          host="tile"
          // the pick applies and the picker stays, as in display mode: the tile shows the
          // scene live and the settings under the tiles switch to it, to tune while looking
          onPick={(id) => void saveSettings({ nowPlayingScene: id })}
        />
      )}
      {/* ambient art backdrop is rendered app-wide by AmbientBackdrop in App */}
      {header}

      {playlistAt && (
        <AddToPlaylistPanel
          label={meta.title ?? "this track"}
          at={playlistAt}
          onClose={() => setPlaylistAt(null)}
          resolve={() =>
            Promise.resolve([
              {
                title: meta.title ?? "",
                artist: meta.subtitle ?? null,
                album: meta.album ?? null,
                artUrl: meta.artUrl ?? null,
                // play_state carries no library ids — content IS the identity,
                // and activation resolves it fresh against whatever server has it
                serverUdn: null,
                serverName: null,
                objectId: null,
                durationSecs: md?.duration ?? null,
              },
            ])
          }
        />
      )}
      {lyricsFade.mounted && <LyricsPanel className={lyricsFade.faded} />}
      {artistFade.mounted && <ArtistPanel className={artistFade.faded} />}

      {/* fixed alignment (settings-chosen) so the layout doesn't shift as track lengths change.
          The art+text pair is one inner unit: text always tops-out level with the art
          (items-start), and right placement mirrors the pair so the art anchors the right
          edge while text grows leftward. */}
      <div
        className={cx(
          "relative flex-1 min-h-0 flex px-8 pb-10",
          ALIGN_H[nowPlayingAlignH],
          ALIGN_V[nowPlayingAlignV],
        )}
      >
        <div className={cx("flex gap-8 items-start min-w-0", mirrored && "flex-row-reverse")}>
          <div className="shrink-0">
            {/* three width tiers — compact windows get genuinely small art
              (260) instead of the old two-step 340/400 (user pass) */}
            {/* Art swaps straight over on a track change — no crossfade here (user
              call 2026-07-24: the text settling and the art dissolving at the
              same time read as mushy). Display mode keeps its crossfade. The
              swap is off the DECODED url, so the tile goes cover-to-cover
              rather than emptying while a slow remote fetch finishes. */}
            {/* the chips sit on the box, not in the scene's clipped corner box, so their
                tips are not cut off; they are the app's glass over content (translucent
                panel over a backdrop blur, as the toasts and the playback bar), so the art
                or the scene shows through them frosted */}
            <div
              data-now-playing-scene={sceneOn ? tileStage : undefined}
              className="group relative w-[260px] h-[260px] lg:w-[340px] lg:h-[340px] xl:w-[400px] xl:h-[400px]"
            >
              {sceneOn && tileStage ? (
                <div className="absolute inset-0 rounded-2xl overflow-hidden bg-raised art-glow">
                  <SceneCanvas
                    scene={tileStage}
                    feed={sceneFeed}
                    mini
                    words={tileWords}
                    className="absolute inset-0"
                  />
                </div>
              ) : (
                <ArtImage
                  src={tileArt}
                  className="w-full h-full object-cover rounded-2xl art-glow"
                  fallback={
                    <div className="w-full h-full rounded-2xl bg-raised ring-1 ring-edge flex items-center justify-center">
                      {meta.isRadio ? (
                        <RadioTower size={72} strokeWidth={1} className="text-faint" />
                      ) : (
                        <Disc3 size={72} strokeWidth={1} className="text-faint" />
                      )}
                    </div>
                  }
                />
              )}
              {sceneOn && lyricsAvailable && tileDef && (
                <button
                  onClick={() => void saveSettings({ nowPlayingSceneWords: !nowPlayingSceneWords })}
                  disabled={wordsForced}
                  aria-label="Lyrics in the scene"
                  aria-pressed={tileWords}
                  data-tip={
                    wordsForced
                      ? `The ${tileDef.label.toLowerCase()} always shows the lyrics`
                      : tileWords
                        ? "Hide lyrics in the scene"
                        : "Show lyrics in the scene"
                  }
                  data-now-playing-scene-words
                  className={cx(
                    "tip-top tip-start absolute bottom-2 left-2 p-2 rounded-full bg-panel/60 backdrop-blur ring-1 ring-edge transition-all opacity-0 group-hover:opacity-100",
                    tileWords ? "text-gold" : "text-dim",
                    wordsForced
                      ? "cursor-default disabled:opacity-60"
                      : "hover:text-ink motion-safe:active:scale-90",
                  )}
                >
                  <Captions size={16} />
                </button>
              )}
              {chipOn && (
                <button
                  onClick={() => setScenesOpen((o) => !o)}
                  aria-label="Scene"
                  data-tip="Scene"
                  data-now-playing-scene-chip
                  className={cx(
                    "tip-top tip-end absolute bottom-2 right-2 p-2 rounded-full bg-panel/60 backdrop-blur ring-1 ring-edge transition-all motion-safe:active:scale-90",
                    scenesOpen
                      ? "text-gold opacity-100"
                      : "text-dim hover:text-ink opacity-0 group-hover:opacity-100",
                  )}
                >
                  <Sparkles size={16} />
                </button>
              )}
            </div>
            {/* EXPERIMENT (0.7 exploration): the waveform as pure form under
                the art — playhead, no controls, absent when no peaks. */}
            <div className="w-[260px] lg:w-[340px] xl:w-[400px]">
              <NowPlayingWaveform />
            </div>
          </div>

          <div className={cx("min-w-0 max-w-xl space-y-5", mirrored && "text-right")}>
            <div className={cx("flex items-center gap-3", mirrored && "justify-end")}>
              {sourceName && <span className="badge">{sourceName}</span>}
              {state && state !== "play" && (state !== "buffering" || bufferingSettled) && (
                <span className={cx("microlabel", state === "pause" ? "text-amber" : "")}>
                  {state === "pause" ? "paused" : state}
                </span>
              )}
            </div>

            <div
              className={cx(
                "space-y-1 transition-opacity duration-300",
                trackVisible ? "opacity-100" : "opacity-0",
              )}
            >
              <h1 className="font-display font-bold text-[clamp(28px,4vw,46px)] leading-[1.08] tracking-tight text-balance">
                {shownTrack.title}
              </h1>
              {shownTrack.subtitle && (
                <div className="font-display text-[23px] leading-tight tracking-tight text-ink/80 truncate">
                  {entryArtist ? (
                    <NameLink
                      kind="artist"
                      name={entryArtist}
                      // display type: a lift to ink and a hairline gold underline set
                      // well below the baseline — the row treatment's underline would
                      // read heavy at this size; nothing at rest
                      className="hover:text-ink hover:underline decoration-1 decoration-gold/50 underline-offset-[6px]"
                    >
                      {shownTrack.subtitle}
                    </NameLink>
                  ) : (
                    shownTrack.subtitle
                  )}
                </div>
              )}
              {shownTrack.album && (
                <div className="text-[14px] text-dim truncate">
                  {entryRef ? (
                    <NameLink
                      kind="album"
                      name={shownTrack.album}
                      ref={entryRef}
                      // the same quiet grammar as the artist line, scaled to 14px: a hairline
                      // gold underline at low alpha, a half step up in tone (the ink lift and
                      // an ink underline read too dramatic here — user, 2026-09-02)
                      className="hover:text-ink/80 hover:underline decoration-1 decoration-gold/40 underline-offset-[4px]"
                    >
                      {shownTrack.album}
                    </NameLink>
                  ) : (
                    shownTrack.album
                  )}
                </div>
              )}
            </div>

            {shownTrack.badges.length > 0 && (
              <div
                className={cx(
                  "flex flex-wrap items-center gap-1.5 transition-opacity duration-300",
                  trackVisible ? "opacity-100" : "opacity-0",
                  mirrored && "justify-end",
                )}
              >
                {shownTrack.badges.map((b) => (
                  <span key={b} className="badge">
                    {b}
                  </span>
                ))}
                <PlayingDrChip />
                <SignalLamp />
              </div>
            )}

            {meta.isRadio && nowPlaying?.display?.line3 && (
              <div className="text-[13px] text-dim">{nowPlaying.display.line3}</div>
            )}

            {queueIndex != null && queueLength != null && queueLength > 0 && (
              <div
                className={cx(
                  "microlabel transition-opacity duration-300",
                  trackVisible ? "opacity-100" : "opacity-0",
                )}
              >
                track {queueIndex + 1} of {queueLength}
              </div>
            )}

            {/* inline lyric flavor — never alongside the full panel; fades with
              the track group so it doesn't pop on a change */}
            {lyricsAvailable && lyricsLine && !lyricsOpen && (
              <div
                className={cx(
                  "transition-opacity duration-300",
                  trackVisible ? "opacity-100" : "opacity-0",
                )}
              >
                <LyricLine />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
