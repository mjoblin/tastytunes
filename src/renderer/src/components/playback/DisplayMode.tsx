import { useEffect, useRef, useState } from "react";
import { Captions, Disc3, RadioTower, X, AudioLines, Sparkles } from "lucide-react";
import type { DisplayScene } from "@shared/model";
import { useStore } from "@/store";
import { CrossfadeArt } from "@/components/media/CrossfadeArt";
import { usePlayhead } from "@/hooks/usePlayhead";
import { useArtLoadable } from "@/hooks/useArtLoadable";
import { useFadePresence } from "@/hooks/useFadePresence";
import { useBestArt } from "@/lib/bestArt";
import { useFadedText, useLyrics } from "@/hooks/useLyrics";
import { useSettledSnapshot } from "@/hooks/useSettledSnapshot";
import { cx, deriveNowPlaying } from "@/lib/format";
import { DisplayWaveform } from "@/components/media/Waveform";
import { tt } from "@/api";
import { FACT_SEP } from "@/lib/mediaFacts";
import { useSceneFeed } from "@/components/display/feed";
import { SceneCanvas } from "@/components/display/SceneCanvas";
import { ScenePicker } from "@/components/display/ScenePicker";
import { SCENES, SCENES_ORDERED, isAbstract } from "@/components/display/scenes";
import { useShuffledScene } from "@/components/display/useShuffledScene";
import type { SceneId } from "@/components/display/scenes/types";

/**
 * Full-screen "display mode" (Roon display mode / Volumio now-playing kiosk):
 * chrome-free art + metadata for a desk or wall screen. Toggled with F; the
 * cursor and close control fade out after a few idle seconds.
 *
 * SCENES (0.8.0): what fills the screen is a choice. Sleeve is the face
 * below — art, title, the words beneath; the abstract scenes
 * (components/display) paint the whole screen from the track's feature
 * strip and its timed lyrics, and the clock, the waveform strip and the
 * caption stay as layers on top. The picker is in-mode like every other
 * display option (the standing rule: never a Settings row), Tab steps through
 * the scenes, and the palette names each one.
 */
export function DisplayMode(): React.JSX.Element {
  const playState = useStore((s) => s.playState);
  const saveSettings = useStore((s) => s.saveSettings);
  const nowPlaying = useStore((s) => s.nowPlaying);
  const setDisplayMode = useStore((s) => s.setDisplayMode);
  const settings = useStore((s) => s.settings);
  const { position, duration } = usePlayhead();
  const [cursorIdle, setCursorIdle] = useState(false);
  const [clock, setClock] = useState(() => timeNow());
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const meta = deriveNowPlaying(playState, nowPlaying);

  // the scene: the setting, or the shuffle's draw for this track (never the
  // one before); the feed only fetches an analysis once a scene needs it
  const [scenesOpen, setScenesOpen] = useState(false);
  // the picker opens at once and fades out at the house beat (useFadePresence, the
  // modals' and the panels' 140 ms), taking no clicks while it is leaving; a fade IN hid
  // its heavy mount behind zero opacity and read as a delay (the user, 2026-09-13)
  const pickerFade = useFadePresence(scenesOpen, { enter: false });
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { shuffled, active } = useShuffledScene(settings.displayScene, meta);
  const stage: SceneId | null = isAbstract(active) ? active : null;
  const feed = useSceneFeed(stage != null || scenesOpen);
  const pickScene = (id: DisplayScene): void => {
    void saveSettings({ displayScene: id });
    const def = SCENES.find((sc) => sc.id === id);
    if (!def) return;
    setToast(def.label);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1500);
  };
  // Tab steps through the scenes without the mouse; Shift+Tab steps back
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Tab") return;
      e.preventDefault();
      const ids = SCENES_ORDERED.map((sc) => sc.id);
      const i = ids.indexOf(settings.displayScene);
      pickScene(ids[(i + (e.shiftKey ? -1 : 1) + ids.length) % ids.length]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.displayScene]);
  // Display mode's 46vmin tile is the biggest art in the app: the file's own
  // picture when the server's is small (lib/bestArt)
  const art = useBestArt(
    meta.artUrl,
    !meta.isRadio && meta.title
      ? { title: meta.title, artist: meta.subtitle ?? null, album: meta.album ?? null }
      : null,
  );

  // Title/artist/badges render from a SETTLED snapshot and fade as one group:
  // on track change the group fades out, and only once the metadata settles
  // does it swap and fade the new track in — so the gap never flashes
  // intermediate/empty states. (The album art crossfades independently.)
  // Signature = the track's identity only; badges ride in the snapshot but
  // never drive the settle (the bitrate badge ticks on its own — a ticking
  // signature re-arms the timer forever and the group stays invisible).
  const liveTextSig = `${meta.title ?? ""}␟${meta.subtitle ?? ""}`;
  const { shown: shownText, visible: textVisible } = useSettledSnapshot(liveTextSig, () => ({
    title: meta.title,
    subtitle: meta.subtitle,
    badges: meta.badges,
  }));

  // Enter OS fullscreen while mounted; leave on unmount. If the user exits
  // fullscreen (Esc), close display mode too.
  useEffect(() => {
    void document.documentElement.requestFullscreen?.().catch(() => {});
    const onChange = (): void => {
      if (!document.fullscreenElement) setDisplayMode(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, [setDisplayMode]);

  useEffect(() => {
    const timer = setInterval(() => setClock(timeNow()), 10_000);
    return () => clearInterval(timer);
  }, []);

  const onMouseMove = (): void => {
    setCursorIdle(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setCursorIdle(true), 3000);
  };

  const artLoadable = useArtLoadable(art);
  const lyricsToggleable = settings.lyrics && !meta.isRadio && !!meta.subtitle;
  const toggleLyrics = async (): Promise<void> => {
    await saveSettings({ displayLyrics: !settings.displayLyrics });
  };

  return (
    // no-drag: the app header underneath keeps its drag region while display mode covers
    // it, and a drag region is a NATIVE hit-test that ignores stacking, so the top of the
    // buttons up here (and the picker) fell in it: hover and clicks only landed on the
    // lower half of each icon. Subtracting this whole surface gives them back.
    <div
      className={cx(
        "fixed inset-0 z-40 bg-bg overflow-hidden no-drag",
        cursorIdle && "cursor-hidden",
      )}
      onMouseMove={onMouseMove}
      onClick={() => scenesOpen && setScenesOpen(false)}
    >
      {stage && (
        <div data-display-stage={stage} className="absolute inset-0">
          <SceneCanvas scene={stage} feed={feed} className="absolute inset-0" />
        </div>
      )}
      {!stage && art && artLoadable && (
        <div
          aria-hidden
          className="absolute inset-0 bg-center bg-cover scale-125 blur-[110px] opacity-25 saturate-150"
          style={{ backgroundImage: `url(${art})` }}
        />
      )}

      <div
        className={cx(
          // The clock shares the lyric line's vertical band (bottom-16), clear of
          // the waveform strip below — one bottom edge for everything that
          // floats above the strip (user call, 2026-08-30).
          "absolute bottom-16 right-7 font-mono text-[13px] text-dim transition-opacity",
          cursorIdle && "opacity-60",
        )}
      >
        <span title="The time of day">{clock}</span>
      </div>
      {stage && (meta.title || meta.subtitle) && (
        <div
          data-display-caption
          className={cx(
            "absolute bottom-16 left-7 max-w-[44vw] truncate font-mono text-[13px] text-dim transition-opacity",
            cursorIdle && "opacity-60",
          )}
        >
          {[meta.title, meta.subtitle].filter(Boolean).join(FACT_SEP)}
        </div>
      )}
      {toast && (
        <div
          data-display-scene-toast
          className="absolute bottom-28 left-1/2 z-30 -translate-x-1/2 rounded-full bg-panel/85 px-4 py-1.5 text-[13px] text-ink ring-1 ring-edge backdrop-blur"
        >
          {toast}
        </div>
      )}

      {/* top-RIGHT: the top-left corner belongs to macOS's (hidden but still
          click-swallowing) traffic-light zone in frameless windows */}
      {/* EXPERIMENT: display mode's own waveform toggle — an in-mode button
          like the lyrics one, never a Settings row (the face composes
          itself). Hidden entirely when the master toggle is off. */}
      <button
        data-display-scene-button
        onClick={() => setScenesOpen((o) => !o)}
        title="Scene (Tab steps through them)"
        className={cx(
          "absolute top-4 right-40 z-20 p-2 rounded-full hover:bg-veil2 transition-opacity",
          scenesOpen || stage ? "text-gold" : "text-dim hover:text-ink",
          cursorIdle && !scenesOpen ? "opacity-0" : "opacity-100",
        )}
      >
        <Sparkles size={18} />
      </button>
      {pickerFade.mounted && (
        <ScenePicker
          className={cx(pickerFade.faded, !scenesOpen && "pointer-events-none")}
          feed={feed}
          current={settings.displayScene}
          shuffled={shuffled}
          art={art}
          onPick={pickScene}
        />
      )}
      {settings.waveforms && (
        <button
          onClick={() => void saveSettings({ displayWaveform: !settings.displayWaveform })}
          title={settings.displayWaveform ? "Hide waveform" : "Show waveform"}
          className={cx(
            "absolute top-4 right-28 z-20 p-2 rounded-full hover:bg-veil2 transition-opacity",
            settings.displayWaveform ? "text-gold" : "text-dim hover:text-ink",
            cursorIdle ? "opacity-0" : "opacity-100",
          )}
        >
          <AudioLines size={18} />
        </button>
      )}
      {lyricsToggleable && (
        <button
          onClick={() => void toggleLyrics()}
          title={settings.displayLyrics ? "Hide lyrics" : "Show lyrics"}
          className={cx(
            "absolute top-4 right-16 z-20 p-2 rounded-full hover:bg-veil2 transition-opacity",
            settings.displayLyrics ? "text-gold" : "text-dim hover:text-ink",
            cursorIdle ? "opacity-0" : "opacity-100",
          )}
        >
          <Captions size={18} />
        </button>
      )}
      <button
        onClick={() => setDisplayMode(false)}
        title="Exit display mode (F)"
        className={cx(
          "absolute top-4 right-4 z-20 p-2 rounded-full text-dim hover:text-ink hover:bg-veil2 transition-opacity",
          cursorIdle ? "opacity-0" : "opacity-100",
        )}
      >
        <X size={18} />
      </button>

      {!stage && lyricsToggleable && settings.displayLyrics && <DisplayLyric />}

      {!stage && (
        <div className="relative h-full flex flex-col items-center justify-center px-16">
          {/* Lock the art in place across track changes: it's a fixed size, so
            we center it (nudged up to leave room for the text) and hang the
            text absolutely beneath it — a longer/shorter title, a missing
            subtitle, or a changing badge count then grow downward instead of
            re-centering the whole group and shifting the art. */}
          <div className="relative -translate-y-[7vmin]">
            <CrossfadeArt
              src={art}
              className="w-[46vmin] h-[46vmin] object-cover rounded-2xl art-glow"
              fallback={
                <div className="w-[46vmin] h-[46vmin] rounded-2xl bg-raised ring-1 ring-edge flex items-center justify-center">
                  {meta.isRadio ? (
                    <RadioTower size={90} strokeWidth={1} className="text-faint" />
                  ) : (
                    <Disc3 size={90} strokeWidth={1} className="text-faint" />
                  )}
                </div>
              }
            />

            <div
              className={cx(
                "absolute top-full left-1/2 -translate-x-1/2 mt-9 w-[70vw] text-center space-y-1 transition-opacity duration-300",
                textVisible ? "opacity-100" : "opacity-0",
              )}
            >
              <div className="font-display font-bold text-[clamp(26px,4.5vmin,52px)] leading-tight tracking-tight text-balance">
                {shownText.title ?? "Nothing playing"}
              </div>
              {shownText.subtitle && (
                <div className="font-display tracking-tight leading-tight text-[clamp(15px,2.2vmin,24px)] text-dim truncate">
                  {shownText.subtitle}
                </div>
              )}
              {shownText.badges.length > 0 && (
                <div className="flex justify-center flex-wrap gap-1.5 pt-6">
                  {shownText.badges.map((b) => (
                    <span key={b} className="badge">
                      {b}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {duration != null && duration > 0 && (
        /* EXPERIMENT (0.7 exploration): the waveform stands in for the
           progress strip when the playing track's peaks exist; the plain
           bar is the fallback for radio, casts and unanalyzed tracks. */
        <DisplayWaveform
          progress={Math.min(1, position / duration)}
          duration={duration}
          onSeek={(pct) =>
            void tt.command({ type: "seek", positionSecs: Math.round(pct * duration) })
          }
          fallback={
            <div className="absolute inset-x-0 bottom-0 h-[3px] bg-veil2">
              <div
                className="h-full bg-amber transition-[width] duration-300 ease-linear"
                style={{ width: `${Math.min(100, (position / duration) * 100)}%` }}
              />
            </div>
          }
        />
      )}
    </div>
  );
}

/**
 * The current synced line, floating above the progress bar. Absolutely
 * positioned and pointer-transparent: it never nudges the centered art/text
 * column, whatever it does. Dim ♪ through LRC gaps/intros (same as the
 * Now Playing inline line); renders nothing without synced lyrics.
 */
function DisplayLyric(): React.JSX.Element | null {
  const { synced, currentIndex } = useLyrics();
  const line = synced && currentIndex >= 0 ? synced[currentIndex].text : "";
  const { shown, visible } = useFadedText(synced ? line || "♪" : "");
  if (!synced) return null;
  const placeholder = shown === "♪";
  return (
    <div className="absolute inset-x-0 bottom-16 px-16 text-center pointer-events-none">
      <div
        className={cx(
          "font-display text-[clamp(17px,2.8vmin,30px)] leading-snug line-clamp-2 text-balance transition-opacity duration-200",
          visible ? "opacity-100" : "opacity-0",
          placeholder ? "text-faint" : "text-gold/90",
        )}
      >
        {shown}
      </div>
    </div>
  );
}

/** The time of day in the user's own clock form ("1:06 AM" here, "01:06" where the day has
 *  24 hours): the bare "01:06" read as an unexplained number (user, 2026-09-07). */
function timeNow(): string {
  return new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
