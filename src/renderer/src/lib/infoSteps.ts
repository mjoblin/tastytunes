import type { MediaInfoTarget } from "@shared/model";
import type { MediaRef } from "@/lib/mediaRef";
import { useStore } from "@/store";

/**
 * TRACK INFO STEPS THROUGH ITS LIST (0.12.0, Malcolm's email of 2026-10-17: arrows "like
 * iTunes/Apple Music", so a reader can look through an album's tracks without closing and
 * reopening). A surface that opens Info on one row of a list hands the whole list over: an
 * album's tracks, the Tracks view as filtered and sorted, the queue, a playlist, search results,
 * History, Favorites. Each entry builds its target when asked (the Library holds the nodes; a
 * list of refs looks each up, lib/mediaInfo), and a step shows the next target only once it has
 * resolved, so the modal never flashes a stub between tracks; the entries either side are asked
 * ahead, so a step is usually immediate. A lone Info (no list) has no arrows.
 */

/** One position in the list: its Info target, built (or looked up) when first asked for. */
export type InfoEntry = () => MediaInfoTarget | Promise<MediaInfoTarget>;

export interface InfoList {
  entries: readonly InfoEntry[];
  index: number;
  /** One per open; every step of that open keeps it (the modal holds its height per session). */
  session: number;
  /** Resolved and in-flight targets by position, shared by every step of the session. */
  cache: Map<number, Promise<MediaInfoTarget>>;
  /** The album whose Info the list was opened from: its tracks' album link goes back to it
   *  as it was (0.12.0, the album's Tracks section), rather than looking the album up. */
  parent?: MediaInfoTarget;
}

let sessions = 0;

/** One page of the Info window's history: what it showed and the list it stepped through. */
export interface InfoPage {
  target: MediaInfoTarget;
  list: InfoList | null;
}

// What a step looks up before it shows, so the next track appears whole (its analysis, its
// cover): the modal registers it (MediaInfoModal), and a slow answer stops holding a step after
// WARM_CAP_MS (the step then shows, and the rest lands as it would have)
let warm: ((target: MediaInfoTarget) => Promise<unknown>) | null = null;
const WARM_CAP_MS = 400;
export function setInfoWarmer(fn: (target: MediaInfoTarget) => Promise<unknown>): void {
  warm = fn;
}

export function newInfoList(
  entries: readonly InfoEntry[],
  index: number,
  parent?: MediaInfoTarget,
): InfoList {
  return { entries, index, session: ++sessions, cache: new Map(), ...(parent ? { parent } : {}) };
}

function resolve(list: InfoList, i: number): Promise<MediaInfoTarget> {
  let p = list.cache.get(i);
  if (!p) {
    p = Promise.resolve()
      .then(() => list.entries[i]())
      .then(async (target) => {
        if (warm)
          await Promise.race([
            warm(target).catch(() => {}),
            new Promise((r) => setTimeout(r, WARM_CAP_MS)),
          ]);
        return target;
      });
    list.cache.set(i, p);
    // a failed lookup is asked again on the next step that wants it
    p.catch(() => list.cache.delete(i));
  }
  return p;
}

function prefetchAround(list: InfoList): void {
  for (const i of [list.index - 1, list.index + 1])
    if (i >= 0 && i < list.entries.length) resolve(list, i).catch(() => {});
}

/** Opens Info on `first`, the entry at `index` of a list (the list's other entries resolve on
 *  demand), with the album it was opened from when there is one; `push` opens it as a new page
 *  of the window's history (from an album's Tracks) rather than in place of the one shown. */
export function openInfoInList(
  first: MediaInfoTarget,
  entries: readonly InfoEntry[],
  index: number,
  parent?: MediaInfoTarget,
  { push = false }: { push?: boolean } = {},
): InfoList {
  const list = newInfoList(entries, index, parent);
  list.cache.set(index, Promise.resolve(first));
  if (push) pushInfo(first, list);
  else useStore.getState().setMediaInfo(first, list);
  prefetchAround(list);
  return list;
}

/** Keeps a list's position while its current entry's target is replaced in place (a ref's
 *  lookup landing on the stub it opened with). */
export function replaceInfoInList(list: InfoList, target: MediaInfoTarget): void {
  list.cache.set(list.index, Promise.resolve(target));
  useStore.getState().setMediaInfo(target, list);
  prefetchAround(list);
}

// The position the latest step asked for: steps pressed faster than lookups land count from it,
// and only the latest one is shown.
let want: { session: number; index: number } | null = null;

/** Whether the list has an entry before (-1) or after (1) the one shown. */
export function canStep(list: InfoList | null, delta: -1 | 1): boolean {
  if (!list) return false;
  const i = list.index + delta;
  return i >= 0 && i < list.entries.length;
}

/** Moves the Info modal one entry along its list; nothing at either end (no wrap). */
export async function stepInfo(delta: -1 | 1): Promise<void> {
  const list = useStore.getState().mediaInfoList;
  if (!list) return;
  const from = want?.session === list.session ? want.index : list.index;
  const index = from + delta;
  if (index < 0 || index >= list.entries.length) return;
  want = { session: list.session, index };
  let target: MediaInfoTarget;
  try {
    target = await resolve(list, index);
  } catch {
    return;
  }
  const now = useStore.getState().mediaInfoList;
  if (!now || now.session !== list.session || want.session !== list.session) return;
  if (want.index !== index) return;
  const next: InfoList = { ...now, index };
  useStore.getState().setMediaInfo(target, next);
  prefetchAround(next);
}

/** A list screen's rows as the refs Info steps through, and the opened row's place among them
 *  (tracks only; rows with no content identity are skipped). Undefined when there is nothing to
 *  step to. */
export function refSiblings<T>(
  rows: readonly T[],
  current: T,
  toRef: (row: T) => MediaRef | null,
): { refs: MediaRef[]; index: number } | undefined {
  const refs: MediaRef[] = [];
  let index = -1;
  for (const row of rows) {
    const ref = toRef(row);
    if (!ref || ref.kind !== "track") continue;
    if (row === current) index = refs.length;
    refs.push(ref);
  }
  return index >= 0 && refs.length > 1 ? { refs, index } : undefined;
}

/**
 * THE INFO WINDOW'S OWN BACK AND FORWARD (0.12.0, his ask: "i'm getting a bit lost as a user
 * and don't know how to get back"). Opening a track from its album's Tracks, or an album from a
 * track's album name, is a new page; a step through a list (‹ ›) replaces the page shown, so
 * back from track 7 is the album, not tracks 6, 5 and 4. The window shows "‹ <the page behind>"
 * at its top-left, and the app's back and forward keys (⌘← ⌘→, ⌘[ ⌘], the mouse's side
 * buttons, Backspace) move through these pages while it is open. Escape still closes it, and
 * closing empties the history (the store's setMediaInfo).
 */
const HISTORY_CAP = 30;

/** Shows `target` as a new page: the page shown goes behind it, and forward empties. */
export function pushInfo(target: MediaInfoTarget, list: InfoList | null = null): void {
  const s = useStore.getState();
  if (!s.mediaInfo) {
    s.setMediaInfo(target, list);
    return;
  }
  want = null;
  useStore.setState({
    mediaInfoBack: [...s.mediaInfoBack, { target: s.mediaInfo, list: s.mediaInfoList }].slice(
      -HISTORY_CAP,
    ),
    mediaInfoForward: [],
    mediaInfo: target,
    mediaInfoList: list,
  });
}

/** Back one page; false when there is none. */
export function infoBack(): boolean {
  const s = useStore.getState();
  const to = s.mediaInfoBack.at(-1);
  if (!s.mediaInfo || !to) return false;
  want = null;
  useStore.setState({
    mediaInfoBack: s.mediaInfoBack.slice(0, -1),
    mediaInfoForward: [...s.mediaInfoForward, { target: s.mediaInfo, list: s.mediaInfoList }],
    mediaInfo: to.target,
    mediaInfoList: to.list,
  });
  return true;
}

/** Forward one page, to where back came from; false when there is none. */
export function infoForward(): boolean {
  const s = useStore.getState();
  const to = s.mediaInfoForward.at(-1);
  if (!s.mediaInfo || !to) return false;
  want = null;
  useStore.setState({
    mediaInfoForward: s.mediaInfoForward.slice(0, -1),
    mediaInfoBack: [...s.mediaInfoBack, { target: s.mediaInfo, list: s.mediaInfoList }],
    mediaInfo: to.target,
    mediaInfoList: to.list,
  });
  return true;
}
