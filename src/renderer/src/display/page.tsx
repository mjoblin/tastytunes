import "@fontsource-variable/instrument-sans";
import "@fontsource/spline-sans-mono/400.css";
import "@fontsource/spline-sans-mono/500.css";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/unbounded";
import "@fontsource-variable/newsreader";
import "@fontsource-variable/hanken-grotesk";
import "@fontsource/instrument-serif/400.css";
import "@fontsource-variable/schibsted-grotesk";
import "../styles.css";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { AppSettings, DisplayScene } from "@shared/model";
import ReactDOM from "react-dom/client";
import { tt } from "@/api";
import { useStore } from "@/store";
import { useTheme } from "@/hooks/useTheme";
import { useDisplayFont } from "@/hooks/useDisplayFont";
import { useMotionPreference } from "@/hooks/useMotionPreference";
import { useAccentChoice } from "@/hooks/useAccentChoice";
import { useArtAccent } from "@/hooks/useArtAccent";
import { deriveNowPlaying } from "@/lib/format";
import { DisplayMode } from "@/components/playback/DisplayMode";
import { holdStages } from "@/components/display/SceneCanvas";
import { askAgainForStored } from "@/components/media/waveformAnalysis";
import { hearControl, useControl } from "./control";
import { followApp } from "./live";
import {
  drawsScenes,
  forgetOwn,
  forThisPage,
  keepOwn,
  ownSettings,
  type OwnKey,
} from "./pageSettings";
import { ControlsSetting, PageTransport, SleepControls, useLocked } from "./PageTransport";
import { ScenePanel } from "./ScenePanel";
import { musicGoing, REST_FADE_MS, REST_OPACITY, useRest } from "./rest";
import { useTouchShown } from "./touch";

/**
 * DISPLAY ON OTHER SCREENS, THE PAGE (0.17.0): the app's own Display mode, full screen, always on,
 * for a tablet or another computer. It follows the streamer through the display server's live
 * channel (display/live), which opens with what is playing now and opens again by itself after a
 * restart or a wake. The window's corner controls are hidden; at a touch the page shows its own
 * (display/ScenePanel: a scene, settings, full screen), which change this screen alone. With the
 * app's Playback controls on, the same touch shows previous, play or pause and next
 * (display/PageTransport), which steer the streamer once the app has allowed this screen. While
 * the streamer sleeps, or the app hasn't been heard for a few seconds, the page goes dark. A
 * touch wakes a resting page, so a screen can be set up in silence.
 *
 * A SCREEN LEFT ON: with the music stopped for a while, the page dims and drifts, a light page
 * turning dark once dimmed (display/rest).
 *
 * SCENES WHERE THEY CAN RUN (stage 2): the owner's scene is drawn where the browser has WebGL2
 * on its GPU, the Sleeve's face everywhere else (asked once, by the browser itself, never by a
 * GPU's name).
 * A scene draws from the playing track's stored analysis, which the page is handed and never
 * measures, and takes its colors from the cover, as in the window (display/webBridge's fetchArt).
 * The owner's accent is worn here too. A screen may show a scene of its own, chosen on it
 * (display/ScenePanel) with the scenes' display-wide settings, all kept in its browser
 * (display/pageSettings).
 */

/** Whether this browser can draw the scenes: a WebGL2 context it will hand out, and not one it
 *  would draw in software (the browser itself refuses that, asked so; no GPU is named), where a
 *  scene would crawl. */
function canDrawScenes(): boolean {
  try {
    const gl = document
      .createElement("canvas")
      .getContext("webgl2", { failIfMajorPerformanceCaveat: true });
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return gl != null;
  } catch {
    return false;
  }
}

const SCENES_HERE = canDrawScenes();
drawsScenes(SCENES_HERE);

/** A track's first play: the window measures it a few seconds in, so a page that found nothing
 *  stored asks again at these times from its first none (components/media/waveformAnalysis). */
const ASK_AGAIN_MS = [20_000, 60_000, 180_000] as const;
askAgainForStored(ASK_AGAIN_MS);

/** The app's settings as last heard, for the scene it shows (this screen may show another). */
let appSettings: AppSettings | null = null;
const appHeard = new Set<() => void>();
const hearApp = (s: AppSettings): void => {
  appSettings = s;
  for (const l of appHeard) l();
};
const useAppScene = (): DisplayScene =>
  useSyncExternalStore(
    (l) => {
      appHeard.add(l);
      return () => appHeard.delete(l);
    },
    () => appSettings?.displayScene ?? "sleeve",
  );

function Page(): React.JSX.Element {
  const [heard, setHeard] = useState(false);
  useEffect(
    () =>
      followApp({
        snapshot: (snap) => {
          hearApp(snap.settings);
          useStore.getState().init({ ...snap, settings: forThisPage(snap.settings) });
        },
        reachable: setHeard,
        control: hearControl,
      }),
    [],
  );
  const settings = useStore((s) => s.settings);
  const powered = useStore((s) => s.systemPower?.power === "ON");
  const connected = useStore((s) => s.connection.phase === "connected");
  const going = useStore((s) => musicGoing(s.playState?.state));
  // the page's own buttons, at a touch (display/touch), held while the panel is open
  const [panelOpen, setPanelOpen] = useState(false);
  // the queue view (display/PageTransport), held open like the panel; one of the two at a time
  const [queueOpen, setQueueOpen] = useState(false);
  const shown = useTouchShown(panelOpen || queueOpen);
  const openPanel = (open: boolean): void => {
    setPanelOpen(open);
    if (open) setQueueOpen(false);
  };
  // the playback buttons, where this screen may have them (display/PageTransport)
  const control = useControl();
  const [locked] = useLocked();
  const transport =
    !locked &&
    (control.state === "ask" || control.state === "asking" || control.state === "allowed");
  const transportShown = transport && shown && !panelOpen;
  // the list closes when there is nothing to show (another source with no presets, the controls
  // off or locked)
  const listHere =
    transport && (control.queue != null || control.presets != null || control.playlists != null);
  useEffect(() => {
    if (!listHere) setQueueOpen(false);
  }, [listHere]);
  // the panel in use (a touch in the last few seconds, or open) keeps the page awake, so a
  // resting screen can be set up; so does a touch or an open list on the sleeping screen, where
  // the panel isn't drawn
  const [panelInUse, setPanelInUse] = useState(false);
  const inUse = panelInUse || shown || queueOpen;
  // a screen left on: dimmed and drifting while the music is stopped and nobody is at it
  // (display/rest)
  const { resting, offset, dark, still } = useRest(going || inUse);
  // and its scene holds its last picture rather than drawing every frame behind the dimming, once
  // a light page's turn to dark has been drawn (a held scene keeps the picture it last drew)
  useEffect(() => holdStages(still), [still]);
  // a light page turns dark once its dimming is done (display/rest)
  const theme = useTheme(dark ? "dark" : settings.theme);
  useDisplayFont(settings.displayFont);
  const reduced = useMotionPreference(settings.motion);
  // the owner's accent, From album art included, as the window wears it (its progress line)
  const artUrl = useStore((s) => deriveNowPlaying(s.playState, s.nowPlaying).artUrl);
  useAccentChoice(settings.accent);
  useArtAccent(settings.accent === "art" && heard ? (artUrl ?? null) : null, theme);
  // a scene for this screen, and its own scene settings: kept in this browser, the app never told
  const appScene = useAppScene();
  const [own, setOwn] = useState<DisplayScene | null>(() => ownSettings().displayScene ?? null);
  const redraw = (): void => {
    if (appSettings)
      useStore.getState().applyPush({ kind: "settings", settings: forThisPage(appSettings) });
  };
  const pickScene = (id: DisplayScene | null): void => {
    if (id == null) forgetOwn(["displayScene"]);
    else keepOwn({ displayScene: id });
    setOwn(id);
    redraw();
  };
  const backToApp = (keys: readonly OwnKey[]): void => {
    forgetOwn(keys);
    redraw();
  };
  return (
    <div
      data-display-scenes={SCENES_HERE ? "on" : "off"}
      data-display-resting={resting || undefined}
      data-controls-shown={transportShown || undefined}
      className="h-dvh w-screen overflow-hidden"
      style={{
        opacity: resting ? REST_OPACITY : 1,
        transform: `translate(${offset[0]}px, ${offset[1]}px)`,
        // the drift glides while resting (stepping under reduced motion); woken, the picture is
        // back in its place at once while the dimming lifts
        transition:
          resting && !reduced
            ? `opacity ${REST_FADE_MS}ms ease, transform 40s linear`
            : `opacity ${REST_FADE_MS}ms ease`,
      }}
    >
      {heard && connected && powered ? (
        <>
          <DisplayMode />
          <PageTransport shown={transportShown} queueOpen={queueOpen} onQueue={setQueueOpen} />
          <ScenePanel
            own={own}
            appScene={appScene}
            onPick={pickScene}
            onAppSettings={backToApp}
            scenes={SCENES_HERE}
            shown={shown}
            open={panelOpen}
            onOpen={openPanel}
            onAwake={setPanelInUse}
            extra={<ControlsSetting />}
          />
        </>
      ) : (
        <div data-display-asleep className="relative h-full w-full bg-black">
          {heard && <SleepControls shown={shown} listOpen={queueOpen} onList={setQueueOpen} />}
        </div>
      )}
    </div>
  );
}

// before the first render: Display mode reads it as it mounts (it asks for full screen only in
// the app's window)
document.documentElement.classList.add("display-page");
tt.onPush((msg) => {
  if (msg.kind === "settings") hearApp(msg.settings);
  useStore
    .getState()
    .applyPush(msg.kind === "settings" ? { ...msg, settings: forThisPage(msg.settings) } : msg);
});
ReactDOM.createRoot(document.getElementById("root")!).render(<Page />);
