import { BrowserWindow, Notification, nativeImage } from "electron";
import type { ZonePlayState } from "@shared/smoip";
import { trackTitle } from "@shared/smoip";
import { getSettings } from "../data/persist";
import { loggedFetch } from "../netlog";

/**
 * OS notification when the track changes while the app is unfocused. The first
 * play_state after a connect only seeds the key — no notification for it.
 * (Split out of DeviceManager in the 0.11.0 sweep; reset() on every new connection.)
 */
export class TrackNotifier {
  private currentTrackKey: string | null = null;

  /** A new connection: its first play_state seeds the key again. */
  reset(): void {
    this.currentTrackKey = null;
  }

  note(playState: ZonePlayState): void {
    const md = playState.metadata;
    const title = trackTitle(md) ?? md?.station ?? null;
    if (!title) return;
    const key = `${title}|${md?.artist ?? ""}`;
    if (key === this.currentTrackKey) return;
    const previous = this.currentTrackKey;
    this.currentTrackKey = key;
    if (previous === null) return;

    if (!getSettings().notifications) return;
    if (!Notification.isSupported()) return;
    if (BrowserWindow.getAllWindows().some((w) => w.isFocused())) return;

    const body = [md?.artist, md?.album].filter(Boolean).join(" — ");
    void (async () => {
      let icon;
      try {
        if (md?.art_url) {
          const res = await loggedFetch("art", md.art_url, { signal: AbortSignal.timeout(2000) });
          if (res.ok) icon = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()));
        }
      } catch {
        // art is optional
      }
      new Notification({
        title,
        body,
        silent: true,
        ...(icon && !icon.isEmpty() ? { icon } : {}),
      }).show();
    })();
  }
}
