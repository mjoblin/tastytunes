/**
 * A PAGE THAT FAILS LOADS AGAIN (0.17.0, Display on other screens): a screen left on has nobody to
 * press reload, and a Home Screen app has no reload control. A render error (display/page's
 * boundary) or a part of the page that didn't arrive (display/entry) reloads it after a wait, longer
 * each time it keeps failing (RELOAD_AFTER_MS), the count kept for this tab and let go once the page
 * has run cleanly for CLEAN_RUN_MS, so a page that fails now and then waits the shortest.
 */

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
 * again. Not up: the next, longer wait, counted as a reload.
 */
export async function reloadWhenUp(deps: {
  store: Store | null;
  sleep: (ms: number) => Promise<void>;
  answers: () => Promise<boolean>;
  reload: () => void;
}): Promise<void> {
  for (;;) {
    await deps.sleep(reloadWait(deps.store));
    if (await deps.answers()) return deps.reload();
  }
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
  });
}
