import { useEffect } from 'react'
import { tt } from '@/api'
import { useStore, type Screen } from '@/store'
import { SCREENS } from '@/lib/screens'

// Derived from the shared registry — the screen lookup runs before the
// transport switch, so a registry key can shadow a transport shortcut (the
// old hand-written copy had l: 'library', silently eating seek-forward).
const SCREEN_KEYS: Record<string, Screen> = Object.fromEntries(
  SCREENS.map((s) => [s.key.toLowerCase(), s.id])
)

export function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // Command palette: ⌘K / Ctrl+K toggles from anywhere, inputs included.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        const s = useStore.getState()
        s.setPaletteOpen(!s.paletteOpen)
        return
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
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        const s = useStore.getState()
        // ⌘⇧F is the editor idiom: find HERE (⌘F, contextual) vs search
        // EVERYWHERE (⌘⇧F, unconditional). The shift form is what reaches the
        // unified screen from inside the Library — where plain ⌘F rightly
        // belongs to the library's own search and its find-recall.
        if (e.shiftKey) s.requestSearch()
        else if (s.screen === 'library') s.requestLibrarySearch()
        else s.requestSearch()
        return
      }

      // ⌘/Alt-← on a PIVOTED Search screen returns where the pivot left
      // ("Search everywhere for X" from the Library) — the browser-back reflex,
      // and the mirror of the Library's own from-search crumb. The library's
      // position restore means landing back exactly where you were browsing.
      // Runs above the input guard so a blurred box isn't required… but only
      // when no input has focus; the search box handles its own just-landed
      // case (SearchScreen), the same split the Library's search bar uses.
      if (
        (e.metaKey || e.ctrlKey || e.altKey) &&
        e.key === 'ArrowLeft' &&
        !(e.target as HTMLElement | null)?.matches?.('input, textarea')
      ) {
        const s = useStore.getState()
        if (s.screen === 'search' && s.searchBack) {
          e.preventDefault()
          s.setScreen(s.searchBack)
          return
        }
      }

      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return
      }
      // A focused drag handle OWNS space and the arrows: dnd-kit's keyboard
      // sensor uses exactly those to pick up, move and drop. Without this the
      // global bindings fire too — space toggles playback and the arrows seek
      // and change volume — so a keyboard reorder plays havoc with the streamer
      // while it works. dnd-kit marks its activators with aria-roledescription
      // ('sortable' from useSortable, 'draggable' from bare useDraggable).
      if (target?.closest('[aria-roledescription="sortable"], [aria-roledescription="draggable"]')) {
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const s = useStore.getState()

      if (e.key === 'Escape') {
        // Palette first: normally its input handles Escape, but if focus has
        // strayed the cascade must not toggle overlays underneath it.
        if (s.paletteOpen) s.setPaletteOpen(false)
        else if (s.shortcutsOpen) s.setShortcutsOpen(false)
        else if (s.infoOpen) s.setInfoOpen(false)
        else if (s.lyricsOpen) s.setLyricsOpen(false)
        else if (s.artistOpen) s.setArtistOpen(false)
        else if (s.displayMode) s.setDisplayMode(false)
        else if (s.diagnosticsOpen) s.setDiagnosticsOpen(false)
        return
      }
      if (e.key === '?') {
        s.setShortcutsOpen(!s.shortcutsOpen)
        return
      }
      if (e.key === '`') {
        s.setDiagnosticsOpen(!s.diagnosticsOpen)
        return
      }

      const screen = SCREEN_KEYS[e.key]
      if (screen) {
        // Search's key is an ASK, not just navigation: "Press S from anywhere"
        // promises a focused box, and a plain setScreen is a no-op when you're
        // already there (same-value set, no re-render, box stays blurred).
        // requestSearch bumps the ask id, which focuses-and-selects either way.
        if (screen === 'search') s.requestSearch()
        else s.setScreen(screen)
        return
      }

      // '/' focuses the list filter on screens that have one.
      if (e.key === '/') {
        const input = document.querySelector<HTMLInputElement>('[data-filter-input]')
        if (input) {
          e.preventDefault()
          input.focus()
          input.select()
        }
        return
      }

      if (s.connection.phase !== 'connected') return

      if (e.key === 'f') {
        s.setDisplayMode(!s.displayMode)
        return
      }

      // 1–9: direct preset recall, radio-tuner style (only for occupied slots)
      if (/^[1-9]$/.test(e.key)) {
        const id = Number(e.key)
        if (s.presets?.presets?.some((p) => p.id === id)) {
          void tt.command({ type: 'recallPreset', presetId: id })
        }
        return
      }

      const seekTo = (delta: number): void => {
        const playhead = s.playhead
        const duration = s.playState?.metadata?.duration
        if (playhead == null) return
        let next = playhead.secs + delta
        if (duration != null) next = Math.min(next, duration - 1)
        void tt.command({ type: 'seek', positionSecs: Math.max(0, next) })
      }

      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault()
          void tt.command({ type: 'togglePlayback' })
          break
        case 'ArrowRight':
          void tt.command({ type: 'nextTrack' })
          break
        case 'ArrowLeft':
          void tt.command({ type: 'previousTrack' })
          break
        case 'ArrowUp':
          e.preventDefault()
          void tt.command({ type: 'volumeStepChange', delta: e.shiftKey ? 5 : 1 })
          break
        case 'ArrowDown':
          e.preventDefault()
          void tt.command({ type: 'volumeStepChange', delta: e.shiftKey ? -5 : -1 })
          break
        case 'j':
          seekTo(-10)
          break
        case 'l':
          seekTo(10)
          break
        case 'm':
          void tt.command({ type: 'setMute', mute: !(s.zoneState?.mute ?? false) })
          break
      }
    }

    // Ownership slot: exactly one shortcut listener per window, ever. If an
    // HMR-orphaned tree left one behind (see main.tsx's idempotence note),
    // evict it — these fire device commands, which must never fan out N×.
    window.__ttShortcutsOff?.()
    window.addEventListener('keydown', onKeyDown)
    const off = (): void => window.removeEventListener('keydown', onKeyDown)
    window.__ttShortcutsOff = off
    return () => {
      off()
      if (window.__ttShortcutsOff === off) window.__ttShortcutsOff = undefined
    }
  }, [])
}

declare global {
  interface Window {
    __ttShortcutsOff?: () => void
  }
}
