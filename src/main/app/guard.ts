import { app, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * THE APP'S OWN PAGES ARE THE ONLY ONES THAT REACH MAIN (0.10.0, the whole-app review).
 * Every window runs sandboxed with the bridge in its preload, and three things keep a page
 * that is not the app's away from it: no window may navigate anywhere but the app's own
 * page (a link dropped on a window used to open the linked page in it, bridge and all), no
 * window opens another (a web link goes to the browser), and every IPC handler answers
 * only a frame showing the app's own page. The app's page is the dev server's origin under
 * `npm run dev` and the built index.html otherwise, whatever query picks the surface
 * (?mini=1, ?tray=1).
 */
const devOrigin = ((): string | null => {
  const url = process.env["ELECTRON_RENDERER_URL"];
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
})();
const rendererIndex = normalize(join(__dirname, "../renderer/index.html"));

export function isAppUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (devOrigin && u.origin === devOrigin) return true;
  if (u.protocol !== "file:") return false;
  try {
    return normalize(fileURLToPath(u)) === rendererIndex;
  } catch {
    return false;
  }
}

/** Installed once, before the first window: every web contents the app creates, the
 *  secondary windows' and DevTools' included, gets the same rules. */
export function installNavigationGuard(): void {
  app.on("web-contents-created", (_e, contents) => {
    contents.on("will-navigate", (event, url) => {
      if (!isAppUrl(url)) event.preventDefault();
    });
    contents.on("will-redirect", (event, url) => {
      if (!isAppUrl(url)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
  });
}

/** ipcMain.handle for the app's own frames only. The contract (TastyTunesApi) types each
 *  channel's arguments; this is the seam where they arrive, untyped, from the preload. */
export function handle<A extends unknown[]>(
  channel: string,
  fn: (e: IpcMainInvokeEvent, ...args: A) => unknown,
): void {
  ipcMain.handle(channel, (e, ...args: unknown[]) => {
    const from = e.senderFrame?.url ?? "";
    if (!isAppUrl(from)) throw new Error(`refused ${channel} from ${from || "an unknown frame"}`);
    return fn(e, ...(args as A));
  });
}

/** ipcMain.on for the app's own frames only: a one-way message from anywhere else is dropped. */
export function listen<A extends unknown[]>(
  channel: string,
  fn: (e: IpcMainEvent, ...args: A) => void,
): void {
  ipcMain.on(channel, (e, ...args: unknown[]) => {
    if (!isAppUrl(e.senderFrame?.url ?? "")) return;
    fn(e, ...(args as A));
  });
}
