import { z } from "zod";
import { DISPLAY_SCENE_IDS, type DisplayScene } from "@shared/model";
import { SCENE_TEXT, orderScenes, sceneText } from "@shared/scenes";
import { type ToolContext, type ToolImpl, ok, err, appState } from "./toolkit";

// The MCP bridge's scene tools (2026-09-14, the catch-up round after the
// visualizer landed): what the scenes are, which one shows on the wall
// (display mode) and in the Now Playing tile, and display mode on or off.
// The choice is the same setting the picker writes (displayScene,
// nowPlayingScene), saved and pushed so the window changes at once; display
// mode itself is renderer state, so the bridge asks the window through the
// menu command channel and reads back what the renderer reports.

export function sceneTools(ctx: ToolContext): Record<string, ToolImpl> {
  return {
    list_scenes: {
      handler: () => {
        const state = appState(ctx);
        return ok({
          scenes: orderScenes(SCENE_TEXT).map((s) => ({
            id: s.id,
            name: s.label,
            description: s.blurb,
            ...(s.id === "sleeve" ? { is_album_art: true } : {}),
            ...(s.id === "shuffle" ? { is_shuffle: true } : {}),
            chosen_for: [
              ...(state.display_mode.scene === s.id ? ["display"] : []),
              ...(state.now_playing_tile.scene === s.id ? ["tile"] : []),
            ],
          })),
          ...state,
        });
      },
    },
    set_scene: {
      inputSchema: {
        scene: z
          .string()
          .describe(
            "A scene id from list_scenes, 'sleeve' for the album art, or 'shuffle' for a different scene each track.",
          ),
        host: z
          .enum(["display", "tile"])
          .describe(
            "'display' for display mode (the full-screen view), 'tile' for the Now Playing art box.",
          ),
      },
      handler: (a) => {
        const scene = String(a.scene).trim().toLowerCase();
        if (!(DISPLAY_SCENE_IDS as readonly string[]).includes(scene))
          return err(
            `Unknown scene '${String(a.scene)}'. list_scenes gives the ids: ${DISPLAY_SCENE_IDS.join(", ")}.`,
          );
        const id = scene as DisplayScene;
        const host = a.host as "display" | "tile";
        ctx.saveSettings(host === "display" ? { displayScene: id } : { nowPlayingScene: id });
        return ok({
          host,
          scene: id,
          name: sceneText(id).label,
          note:
            id === "sleeve"
              ? "The album art shows."
              : id === "shuffle"
                ? "A different scene each track, from the scenes the user has left in the rotation."
                : "Abstract scenes draw once the playing track has been analyzed (local media only); until then the album art shows.",
        });
      },
    },
    set_display_mode: {
      inputSchema: {
        on: z.boolean().describe("true to enter display mode, false to leave it."),
      },
      handler: (a) => {
        const on = a.on === true;
        ctx.sendCommand({ id: on ? "displayModeOn" : "displayModeOff" });
        return ok(
          on
            ? `Display mode on (the TastyTunes window goes full screen with the ${sceneText(appState(ctx).display_mode.scene).label} scene).`
            : "Display mode off.",
        );
      },
    },
  };
}
