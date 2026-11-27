/**
 * A PAGE THAT FAILS LOADS AGAIN (0.17.0, Display on other screens): a screen left on has nobody to
 * press reload, and a Home Screen app has no reload control. A render error (display/page's
 * boundary) or a part of the page that didn't arrive (display/entry) reloads it after a wait, longer
 * each time it keeps failing (RELOAD_AFTER_MS), the count kept for this tab and let go once the page
 * has run cleanly for CLEAN_RUN_MS, so a page that fails now and then waits the shortest.
 * A failed page draws nothing, so once the app hasn't answered, the screen says it can't reach it
 * (sayWaiting), rather than stay black with no word.
 */
import { APP_UNREACHABLE } from "./dark";

export const RELOAD_AFTER_MS = [3_000, 10_000, 30_000, 60_000] as const;
export const CLEAN_RUN_MS = 60_000;
const KEY = "tt-display-reloads";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The wait before this reload, counting it: the reloads before it pick the step. */
export function reloadWait(store: Store | null): number {
  let n = 0;
  try {
    n = Math.max(0, Math.floor(Number(store?.getItem(KEY)) || 0));
    store?.setItem(KEY, String(n + 1));
  } catch {
    // a browser that keeps nothing for the tab waits the shortest every time
  }
  return RELOAD_AFTER_MS[Math.min(n, RELOAD_AFTER_MS.length - 1)];
}

/** The page ran cleanly: its next failure waits the shortest again. */
export function forgetReloads(store: Store | null): void {
  try {
    store?.removeItem(KEY);
  } catch {
    // nothing kept, nothing to let go
  }
}

const session = (): Store | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

let clean: ReturnType<typeof setTimeout> | undefined;
let reloading = false;

/** The page is up: once it has run cleanly for CLEAN_RUN_MS, the count is let go. */
export function runningCleanly(): void {
  clearTimeout(clean);
  clean = setTimeout(() => forgetReloads(session()), CLEAN_RUN_MS);
}

/**
 * After each wait, ask the app first and reload only once it answers (any answer, a refused one
 * included: the page's own server is up): a reload while the app is still down (it restarted
 * between the page's files) lands on the browser's own error page, with no script left to try
 * again. Not up: the next, longer wait, counted as a reload; from the first, the page is waiting
 * for the app (`waiting`), which it says.
 */
export async function reloadWhenUp(deps: {
  store: Store | null;
  sleep: (ms: number) => Promise<void>;
  answers: () => Promise<boolean>;
  reload: () => void;
  waiting: () => void;
}): Promise<void> {
  for (let asked = 0; ; asked++) {
    await deps.sleep(reloadWait(deps.store));
    if (await deps.answers()) return deps.reload();
    if (asked === 0) deps.waiting();
  }
}

/** The waiting line's element. */
const WAITING_ID = "display-waiting";

/** The dark page's line for the app out of reach (display/dark), drawn once and plainly where the
 *  dark page draws it, low and centered: the page that failed draws nothing (its boundary draws
 *  nothing, or the page never loaded), and its styles may not have arrived, so the color is the
 *  dark theme's dim (styles.css --color-dim), the page being black whatever its theme. */
function sayWaiting(): void {
  if (document.getElementById(WAITING_ID)) return;
  const line = document.createElement("p");
  line.id = WAITING_ID;
  line.textContent = APP_UNREACHABLE;
  line.setAttribute(
    "style",
    "position:fixed;left:0;right:0;bottom:calc(env(safe-area-inset-bottom, 0px) + 0.75rem);margin:0 auto;max-width:min(36rem,90vw);padding:0 1rem;text-align:center;font:15px/1.375 var(--font-sans, system-ui, sans-serif);color:#a69e90",
  );
  document.body.append(line);
}

/** Reload the page once the app answers, after its wait (once, however many failures led here). */
export function reloadSoon(why: unknown): void {
  if (reloading) return;
  reloading = true;
  clearTimeout(clean);
  console.error("[display] the page failed, reloading once TastyTunes answers", why);
  void reloadWhenUp({
    store: session(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    answers: () =>
      fetch("/api/snapshot", { credentials: "same-origin", cache: "no-store" }).then(
        () => true,
        () => false,
      ),
    reload: () => location.reload(),
    waiting: sayWaiting,
  });
}
