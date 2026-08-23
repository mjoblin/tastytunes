import { useEffect } from "react";
import { tt } from "@/api";
import { useStore, type Screen } from "@/store";
import { SCREENS } from "@/lib/screens";

// Derived from the shared registry — the screen lookup runs before the
// transport switch, so a registry key can shadow a transport shortcut (the
// old hand-written copy had l: 'library', silently eating seek-forward).
const SCREEN_KEYS: Record<string, Screen> = Object.fromEntries(
  SCREENS.map((s) => [s.key.toLowerCase(), s.id]),
);

/**
 * `transportOnly` is the MINI PLAYER's mode: a window with no screens, no
 * palette and no overlays has no business binding the keys that reach them, so
 * it takes the playback half only — play/pause, seek, track skips, volume,
 * mute. The transport switch itself stays in ONE place; a second hook would
 * drift from this one the first time a binding changed.
 */
export function useShortcuts(opts?: { transportOnly?: boolean }): void {
  const transportOnly = opts?.transportOnly === true;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // Command palette: ⌘K / Ctrl+K toggles from anywhere, inputs included.
      if (
        !transportOnly &&
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        (e.key === "k" || e.key === "K")
      ) {
        e.preventDefault();
        const s = useStore.getState();
        s.setPaletteOpen(!s.paletteOpen);
        return;
      }
      // ⌘F / Ctrl+F: find semantics, and CONTEXTUAL like a browser's.
      //
      // Inside the Library it opens the LIBRARY's own search — that surface has
      // scoping, cross-server mode and find-recall (⌘F brings back your last
      // search with its scope, filters and sort), none of which the unified
      // screen replicates. Pointing ⌘F away from it would have quietly killed
      // find-recall. Everywhere else it opens the unified Search screen, which
      // is the "I don't know where it is" tool. Search also has 'S', the nav
      // row and the palette, so it loses no discoverability by yielding ⌘F on
      // the one screen with a better answer.
      if (
        !transportOnly &&
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        (e.key === "f" || e.key === "F")
      ) {
        e.preventDefault();
        const s = useStore.getState();
        // ⌘⇧F is the editor idiom: find HERE (⌘F, contextual) vs search
        // EVERYWHERE (⌘⇧F, unconditional). The shift form is what reaches the
        // unified screen from inside the Library — where plain ⌘F rightly
        // belongs to the library's own search and its find-recall.
        if (e.shiftKey) s.requestSearch();
        else if (s.screen === "library") s.requestLibrarySearch();
        else s.requestSearch();
        return;
      }

      // ⌘/Alt-← on a PIVOTED Search screen returns where the pivot left
      // ("Search everywhere for X" from the Library) — the browser-back reflex,
      // and the mirror of the Library's own from-search crumb. The library's
      // position restore means landing back exactly where you were browsing.
      // Runs above the input guard so a blurred box isn't required… but only
      // when no input has focus; the search box handles its own just-landed
      // case (SearchScreen), the same split the Library's search bar uses.
      // BROWSER-STYLE HISTORY, APP-WIDE (2026-08-23): ⌘/Alt/Ctrl + ←/→ walk ONE
      // stack across screens and within the Library — back undoes the most
      // recent navigation whatever kind it was. Never inside a text box (a
      // caret key there; the search box handles its own just-landed case);
      // the Library's Backspace stays "up a level". Mouse 4/5 below, same two
      // actions, and View › Back/Forward relays to them too.
      if (
        !transportOnly &&
        (e.metaKey || e.ctrlKey || e.altKey) &&
        !e.shiftKey &&
        (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
        !(e.target as HTMLElement | null)?.matches?.("input, textarea, [contenteditable]")
      ) {
        e.preventDefault();
        const s = useStore.getState();
        if (e.key === "ArrowLeft") s.goBack();
        else s.goForward();
        return;
      }

      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      // A focused drag activator OWNS space and the arrows: dnd-kit's keyboard
      // sensor uses exactly those to pick up, move and drop. Without this the
      // global bindings fire too — space toggles playback and the arrows seek
      // and change volume — so a keyboard reorder plays havoc with the streamer
      // while it works. dnd-kit marks its activators with aria-roledescription
      // ('sortable' from useSortable, 'draggable' from bare useDraggable).
      //
      // MATCHES, NOT CLOSEST (user report 2026-07-27: "up/down scrolls after I
      // click a preset"). Rows put the attributes on the grip button, so the
      // activator IS the focused element and either test works — but preset and
      // queue CARDS spread them on the tile root, which makes every button
      // inside the card "within a sortable". Clicking a card leaves focus on
      // its recall button, and the broad test then swallowed volume, seek and
      // play/pause until focus moved elsewhere. Narrowing costs nothing:
      // dnd-kit's keyboard sensor already refuses to start a drag from a
      // bubbled event (`if (activator && event.target !== activator) return
      // false` in core.esm.js), so a child's keydown was never going to reorder
      // anything.
      if (
        target?.matches('[aria-roledescription="sortable"], [aria-roledescription="draggable"]')
      ) {
        return;
      }
      // SPACE ON A FOCUSED CONTROL PRESSES THE CONTROL, nothing else. Native
      // buttons activate on space, and the row-divs carry role="button" with
      // their own space handler — but a window-level listener hears the
      // keydown regardless (preventDefault doesn't stop bubbling), so one
      // press played the focused row AND toggled playback underneath it. The
      // panel made this easy to hit (every row is focusable and clicking one
      // leaves it focused); the same collision existed on every surface.
      // Space only: arrows and letters stay global — a focused button has no
      // use for them, and yielding those would kill volume/seek for as long
      // as any control held focus.
      if (e.key === " " && target?.matches('button, [role="button"], a[href], summary')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const s = useStore.getState();

      if (!transportOnly) {
        if (e.key === "Escape") {
          // Palette first: normally its input handles Escape, but if focus has
          // strayed the cascade must not toggle overlays underneath it.
          if (s.paletteOpen) s.setPaletteOpen(false);
          else if (s.mediaInfo) s.setMediaInfo(null);
          else if (s.shortcutsOpen) s.setShortcutsOpen(false);
          else if (s.infoOpen) s.setInfoOpen(false);
          else if (s.lyricsOpen) s.setLyricsOpen(false);
          else if (s.artistOpen) s.setArtistOpen(false);
          else if (s.displayMode) s.setDisplayMode(false);
          else if (s.diagnosticsOpen) s.setDiagnosticsOpen(false);
          return;
        }
        if (e.key === "?") {
          s.setShortcutsOpen(!s.shortcutsOpen);
          return;
        }
        if (e.key === "`") {
          s.setDiagnosticsOpen(!s.diagnosticsOpen);
          return;
        }

        const screen = SCREEN_KEYS[e.key];
        if (screen) {
          // Search's key is an ASK, not just navigation: "Press S from anywhere"
          // promises a focused box, and a plain setScreen is a no-op when you're
          // already there (same-value set, no re-render, box stays blurred).
          // requestSearch bumps the ask id, which focuses-and-selects either way.
          if (screen === "search") s.requestSearch();
          else s.setScreen(screen);
          return;
        }

        // '/' focuses the list filter on screens that have one.
        if (e.key === "/") {
          const input = document.querySelector<HTMLInputElement>("[data-filter-input]");
          if (input) {
            e.preventDefault();
            input.focus();
            input.select();
          }
          return;
        }
      }

      if (s.connection.phase !== "connected") return;

      if (!transportOnly && e.key === "f") {
        s.setDisplayMode(!s.displayMode);
        return;
      }

      // 1–9: direct preset recall, radio-tuner style (only for occupied slots)
      if (!transportOnly && /^[1-9]$/.test(e.key)) {
        const id = Number(e.key);
        if (s.presets?.presets?.some((p) => p.id === id)) {
          void tt.command({ type: "recallPreset", presetId: id });
        }
        return;
      }

      const seekTo = (delta: number): void => {
        const playhead = s.playhead;
        const duration = s.playState?.metadata?.duration;
        if (playhead == null) return;
        let next = playhead.secs + delta;
        if (duration != null) next = Math.min(next, duration - 1);
        void tt.command({ type: "seek", positionSecs: Math.max(0, next) });
      };

      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          void tt.command({ type: "togglePlayback" });
          break;
        case "ArrowRight":
          void tt.command({ type: "nextTrack" });
          break;
        case "ArrowLeft":
          void tt.command({ type: "previousTrack" });
          break;
        case "ArrowUp":
          e.preventDefault();
          void tt.command({ type: "volumeStepChange", delta: e.shiftKey ? 5 : 1 });
          break;
        case "ArrowDown":
          e.preventDefault();
          void tt.command({ type: "volumeStepChange", delta: e.shiftKey ? -5 : -1 });
          break;
        case "j":
          seekTo(-10);
          break;
        case "l":
          seekTo(10);
          break;
        case "m":
          void tt.command({ type: "setMute", mute: !(s.zoneState?.mute ?? false) });
          break;
      }
    };

    // Ownership slot: exactly one shortcut listener per window, ever. If an
    // HMR-orphaned tree left one behind (see main.tsx's idempotence note),
    // evict it — these fire device commands, which must never fan out N×.
    window.__ttShortcutsOff?.();
    window.addEventListener("keydown", onKeyDown);
    const onMouseUp = (e: MouseEvent): void => {
      if (transportOnly) return;
      if (e.button === 3) {
        e.preventDefault();
        useStore.getState().goBack();
      } else if (e.button === 4) {
        e.preventDefault();
        useStore.getState().goForward();
      }
    };
    window.addEventListener("mouseup", onMouseUp);
    const off = (): void => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.__ttShortcutsOff = off;
    return () => {
      off();
      if (window.__ttShortcutsOff === off) window.__ttShortcutsOff = undefined;
    };
  }, [transportOnly]);
}

declare global {
  interface Window {
    __ttShortcutsOff?: () => void;
  }
}
