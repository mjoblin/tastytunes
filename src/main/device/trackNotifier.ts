import { BrowserWindow, Notification, nativeImage } from "electron";
import type { ZonePlayState } from "@shared/smoip";
import { trackTitle } from "@shared/smoip";
import { getSettings } from "../data/persist";
import { artHostTrust, fetchPicture } from "../lookups/artFetch";

/**
 * OS notification when the track changes while the app is unfocused. The first
 * play_state after a connect only seeds the key — no notification for it.
 * (Split out of DeviceManager in the 0.11.0 sweep; reset() on every new connection.)
 */
export class TrackNotifier {
  private currentTrackKey: string | null = null;

  /** `host`: the streamer connected now, whose picture the notice may fetch (lookups/artFetch). */
  constructor(private readonly host: () => string | null = () => null) {}

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
        // through the one picture fetch: every hop checked, capped (0.16.0: any host, an
        // unbounded body)
        const got = md?.art_url
          ? await fetchPicture(md.art_url, artHostTrust(this.host()), {
              maxBytes: 3_000_000,
              timeoutMs: 2000,
              logged: true,
            })
          : null;
        if (got) icon = nativeImage.createFromBuffer(got.bytes);
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
