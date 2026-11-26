import type { DisplayControl } from "@shared/displayControl";
import type { PushMessage, Snapshot } from "@shared/ipc";

/**
 * THE PAGE'S LINE TO THE APP (0.17.0, Display on other screens): one live channel
 * (main/servers/displayServer's /api/live), whole on its own. Every connection opens with the
 * reduced snapshot, so a reconnect after a wake or a restart shows what is playing now, never
 * the last track; the app pings every few seconds, so a page that hears nothing for a while
 * knows it has lost the app (it goes dark) and opens the channel again. A channel the app
 * refuses (a new address was made) asks once whether this page is still let in, and if not,
 * reloads into the app's "open the address" page. Beside the app's pushes, the screen's own line:
 * where it stands with the controls (`event: control`, display/control), sent to this screen alone;
 * and the word that the app has stored the analysis of a track this page asked about
 * (`event: measured`, its key), so a track measured as it plays reaches the page as it lands.
 * A NEW BUILD RELOADS THE PAGE: each connection says which build of the page the app serves
 * (`event: build`); the first is this page's, and a later one that differs (the app was updated or
 * rebuilt and restarted) reloads it, so a screen left on for days never runs yesterday's page.
 */

/** The build this page was loaded as: the first the app named. */
let loadedBuild: string | null = null;

/** About two missed pings (PING_MS, 5 s). */
const LOST_MS = 12_000;
const AGAIN_MS = 3_000;

const listeners = new Set<(msg: PushMessage) => void>();

/** The app's pushes, for the web bridge's onPush. A snapshot arrives as its settings too. */
export function listenPushes(cb: (msg: PushMessage) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export interface Follow {
  snapshot(snap: Snapshot): void;
  /** Where this screen stands with the controls, at every connection and when it changes. */
  control?(control: DisplayControl): void;
  /** The app stored the analysis under this key (a track the page asked about). */
  measured?(contentKey: string): void;
  /** Whether the app is heard: false after LOST_MS of silence, true at the next word. */
  reachable(heard: boolean): void;
}

export function followApp(follow: Follow): () => void {
  let source: EventSource | null = null;
  let heardAt = 0;
  let openedAt = 0;
  let heard = false;
  let ended = false;
  let again: ReturnType<typeof setTimeout> | undefined;

  const hear = (): void => {
    heardAt = Date.now();
    if (!heard) {
      heard = true;
      follow.reachable(true);
    }
  };
  const later = (): void => {
    clearTimeout(again);
    if (!ended) again = setTimeout(open, AGAIN_MS);
  };
  const drop = (): void => {
    source?.close();
    source = null;
  };
  function open(): void {
    drop();
    openedAt = Date.now();
    const live = new EventSource("/api/live");
    source = live;
    live.addEventListener("snapshot", (e: MessageEvent<string>) => {
      hear();
      const snap = JSON.parse(e.data) as Snapshot;
      follow.snapshot(snap);
      for (const l of listeners) l({ kind: "settings", settings: snap.settings });
    });
    live.addEventListener("ping", hear);
    live.addEventListener("build", (e: MessageEvent<string>) => {
      const build = JSON.parse(e.data) as string;
      if (!build) return;
      if (loadedBuild == null) loadedBuild = build;
      else if (build !== loadedBuild) location.reload();
    });
    live.addEventListener("control", (e: MessageEvent<string>) => {
      hear();
      follow.control?.(JSON.parse(e.data) as DisplayControl);
    });
    live.addEventListener("measured", (e: MessageEvent<string>) => {
      hear();
      follow.measured?.(JSON.parse(e.data) as string);
    });
    live.onmessage = (e: MessageEvent<string>) => {
      hear();
      const msg = JSON.parse(e.data) as PushMessage;
      for (const l of listeners) l(msg);
    };
    live.onerror = () => {
      // still connecting: the browser tries again by itself
      if (live.readyState !== EventSource.CLOSED || source !== live) return;
      drop();
      // refused: still let in (the app was busy, or full), or a new address was made
      void fetch("/api/snapshot", { credentials: "same-origin", cache: "no-store" }).then(
        (res) => (res.status === 401 ? location.reload() : later()),
        later,
      );
    };
  }

  const watch = setInterval(() => {
    const now = Date.now();
    if (heard) {
      if (now - heardAt < LOST_MS) return;
      heard = false;
      follow.reachable(false);
      // a connection that went quiet (the computer slept, the network moved) is opened afresh
      open();
      return;
    }
    // and while nothing is heard, again every LOST_MS: a connection that opened and died before
    // its snapshot would otherwise wait on the browser's own timeout
    if (now - openedAt >= LOST_MS) open();
  }, 2_000);
  open();
  return () => {
    ended = true;
    clearInterval(watch);
    clearTimeout(again);
    drop();
  };
}
