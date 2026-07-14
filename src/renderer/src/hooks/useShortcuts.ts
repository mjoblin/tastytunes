import { useEffect } from 'react'
import { tt } from '@/api'
import { useStore, type Screen } from '@/store'

const SCREEN_KEYS: Record<string, Screen> = {
  n: 'now-playing',
  q: 'queue',
  p: 'presets',
  s: 'sources',
  d: 'device',
  e: 'settings'
}

export function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const s = useStore.getState()

      if (e.key === 'Escape') {
        if (s.shortcutsOpen) s.setShortcutsOpen(false)
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
        s.setScreen(screen)
        return
      }

      if (s.connection.phase !== 'connected') return

      if (e.key === 'f') {
        s.setDisplayMode(!s.displayMode)
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

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
