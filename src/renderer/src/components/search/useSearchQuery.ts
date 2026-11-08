// THE SEARCH BOX'S QUERY AND FOCUS (moved out of SearchScreen.tsx as they were, 0.16.0's tidy): the
// query, remembered for the session, and how an ask (⌘F, the nav, the palette, a pivot) focuses
// and selects it while a history arrival leaves it blurred.
import { useEffect, useRef, useState } from "react";
import { useStore } from "@/store";
import { searchMemory } from "./searchKit";

export function useSearchQuery(): {
  query: string;
  setQuery: (query: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
} {
  const [query, setQuery] = useState(searchMemory.query);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    searchMemory.query = query;
  }, [query]);

  // ⌘F / the nav / the palette all land here; the ask carries an id so a
  // request made before this mounted still focuses, and can't re-fire later.
  const searchRequest = useStore((s) => s.searchRequest);
  const clearSearchRequest = useStore((s) => s.clearSearchRequest);
  const doneReq = useRef(-1);
  /** A seeded query whose select() must wait for its VALUE to commit. */
  const selectPending = useRef<string | null>(null);
  /** The pending focus frame — cancelled only by a newer one or by unmount, never by the effect re-running. */
  const focusFrame = useRef(0);
  useEffect(() => {
    const asked = searchRequest != null && doneReq.current !== searchRequest.id;
    if (searchRequest) {
      doneReq.current = searchRequest.id;
      // A seeded ask (the Library→Search pivot: "Search everywhere for X")
      // replaces the recalled query. Chips stay as they are — the point of a
      // pivot is seeing which collections answer, so nothing gets hidden.
      // The select happens in the [query] effect below, NOT here: selecting in
      // this effect's frame grabs the OLD value, and the seeded value's commit
      // then collapses the caret to the end — which silently killed ⌘←'s
      // just-landed navigation after a pivot.
      if (asked && searchRequest.query != null) {
        selectPending.current = searchRequest.query;
        setQuery(searchRequest.query);
      }
      clearSearchRequest();
    } else if (doneReq.current !== -1) {
      // the re-run after an ask was cleared: the ask's own frame below is
      // already scheduled and must survive this run (cancelling it here is
      // what used to lose the select — S on this screen focused but never
      // selected the recalled query)
      return;
    }
    // FOCUS ON THE NEXT FRAME, never synchronously in the effect. Arriving here
    // by pressing `S` means this mount happens during that keydown, and a synchronous
    // focus hands the keystroke's own default action to the newly focused
    // input — which typed the "s" into the box (the query read "smock").
    // A frame later the keystroke is long finished.
    // INTENT PREPARES, HISTORY RESTORES (2026-08-23): S, the nav row, ⌘F and a
    // pivot are intent to type, so the box takes focus. Back/Forward is
    // restoration — the query, the results and the scroll come back as they
    // were, and the focus state they were left in was "not in the box"
    // (hotkeys and ⌘← don't fire from inside it) — so the box stays blurred
    // and the next ⌘→ is history again, not a caret move. S re-focuses.
    if (!asked && useStore.getState().arrivedByHistory) return;
    cancelAnimationFrame(focusFrame.current);
    focusFrame.current = requestAnimationFrame(() => {
      inputRef.current?.focus();
      // find idiom: an asked-for search arrives with the recalled query
      // selected, so typing replaces it. A plain visit leaves the caret alone.
      if (asked && selectPending.current == null) inputRef.current?.select();
    });
  }, [searchRequest, clearSearchRequest]);
  useEffect(() => () => cancelAnimationFrame(focusFrame.current), []);
  // The seeded-ask select, once the value it belongs to is really in the box.
  useEffect(() => {
    if (selectPending.current == null || query !== selectPending.current) return;
    selectPending.current = null;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [query]);

  return { query, setQuery, inputRef };
}
