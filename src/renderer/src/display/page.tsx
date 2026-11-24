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

import { useEffect, useState } from "react";
import type { AppSettings } from "@shared/model";
import ReactDOM from "react-dom/client";
import { tt } from "@/api";
import { useStore } from "@/store";
import { useTheme } from "@/hooks/useTheme";
import { useDisplayFont } from "@/hooks/useDisplayFont";
import { useMotionPreference } from "@/hooks/useMotionPreference";
import { DisplayMode } from "@/components/playback/DisplayMode";
import { followApp } from "./live";
import { musicGoing, REST_OPACITY, useRest } from "./rest";

/**
 * DISPLAY ON OTHER SCREENS, THE PAGE (0.17.0): the app's own Display mode, full screen, always on,
 * for a tablet or another computer. It follows the streamer through the display server's live
 * channel (display/live), which opens with what is playing now and opens again by itself after a
 * restart or a wake. Its own controls (the close button, the scene picker) are hidden: a page on
 * another screen shows, it doesn't steer. While the streamer sleeps, or the app hasn't been
 * heard for a few seconds, the page goes dark.
 *
 * A SCREEN LEFT ON: with the music stopped for a while, the page dims and drifts (display/rest).
 *
 * SCENES WHERE THEY CAN RUN (stage 2): the owner's scene is drawn where the browser has WebGL2,
 * the Sleeve's face everywhere else (asked once, by the browser itself, never by a GPU's name).
 * A scene draws from the playing track's stored analysis, which the page is handed and never
 * measures.
 */

/** Whether this browser can draw the scenes: a WebGL2 context it will hand out. */
function canDrawScenes(): boolean {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return gl != null;
  } catch {
    return false;
  }
}

const SCENES_HERE = canDrawScenes();

/** The settings as this page draws them: without WebGL2, every scene is the Sleeve. */
const forThisPage = (s: AppSettings): AppSettings =>
  SCENES_HERE ? s : { ...s, displayScene: "sleeve" };
function Page(): React.JSX.Element {
  const [heard, setHeard] = useState(false);
  useEffect(
    () =>
      followApp({
        snapshot: (snap) =>
          useStore.getState().init({ ...snap, settings: forThisPage(snap.settings) }),
        reachable: setHeard,
      }),
    [],
  );
  const settings = useStore((s) => s.settings);
  const powered = useStore((s) => s.systemPower?.power === "ON");
  const connected = useStore((s) => s.connection.phase === "connected");
  const going = useStore((s) => musicGoing(s.playState?.state));
  // a screen left on: dimmed and drifting while the music is stopped (display/rest)
  const { resting, offset } = useRest(going);
  const [reduced, setReduced] = useState(false);
  useTheme(settings.theme);
  useDisplayFont(settings.displayFont);
  useMotionPreference(settings.motion);
  useEffect(() => {
    document.documentElement.classList.add("display-page");
  }, []);
  // the drift glides unless motion is reduced, when it steps (the dimming fades either way)
  useEffect(() => {
    setReduced(document.documentElement.classList.contains("reduce-motion"));
  }, [settings.motion]);
  return (
    <div
      data-display-scenes={SCENES_HERE ? "on" : "off"}
      data-display-resting={resting || undefined}
      className="h-screen w-screen overflow-hidden"
      style={{
        opacity: resting ? REST_OPACITY : 1,
        transform: `translate(${offset[0]}px, ${offset[1]}px)`,
        transition: reduced ? "opacity 3s ease" : "opacity 3s ease, transform 40s linear",
      }}
    >
      {heard && connected && powered ? (
        <DisplayMode />
      ) : (
        <div data-display-asleep className="h-full w-full bg-black" />
      )}
    </div>
  );
}

tt.onPush((msg) =>
  useStore
    .getState()
    .applyPush(msg.kind === "settings" ? { ...msg, settings: forThisPage(msg.settings) } : msg),
);
ReactDOM.createRoot(document.getElementById("root")!).render(<Page />);
