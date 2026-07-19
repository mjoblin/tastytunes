import { Command, PanelLeftClose, PanelLeftOpen, PictureInPicture2 } from 'lucide-react'
import { tt } from '@/api'
import { useStore } from '@/store'
import { cx } from '@/lib/format'
import { MOD, NAV_SCREENS, SETTINGS_SCREEN, type ScreenDef } from '@/lib/screens'

export function Nav(): React.JSX.Element {
  const screen = useStore((s) => s.screen)
  const connection = useStore((s) => s.connection)
  const saveSettings = useStore((s) => s.saveSettings)
  const setScreen = useStore((s) => s.setScreen)
  const setInfoOpen = useStore((s) => s.setInfoOpen)
  const setPaletteOpen = useStore((s) => s.setPaletteOpen)
  const queueTotal = useStore((s) => s.queue?.total ?? null)
  const ambientWindow = useStore((s) => s.ambientWindowActive)
  const settings = useStore((s) => s.settings)
  const update = useStore((s) => s.update)

  const collapsed = settings.navCollapsed
  const toggleCollapsed = async (): Promise<void> => {
    await saveSettings({ navCollapsed: !collapsed })
  }

  const navItem = ({ id, label, icon: Icon, key }: ScreenDef): React.JSX.Element => (
    <button
      key={id}
      onClick={() => setScreen(id)}
      data-tip={`${label} (${key})`}
      aria-label={`${label} (${key})`}
      className={cx(
        'w-full flex items-center rounded-lg h-9 text-[13.5px] transition-colors',
        collapsed ? 'justify-center px-0' : 'gap-3 px-3',
        screen === id ? 'bg-amberdim text-amber' : 'text-dim hover:text-ink hover:bg-veil'
      )}
    >
      <Icon size={16} strokeWidth={1.8} className="shrink-0" />
      {!collapsed && (
        // inner wrapper clips so labels never re-wrap mid collapse/expand
        <span className="flex-1 min-w-0 flex items-center gap-3 overflow-hidden whitespace-nowrap">
          <span className="flex-1 text-left">{label}</span>
          {id === 'queue' && queueTotal != null && queueTotal > 0 && (
            <span className="font-mono text-[10px] text-faint">{queueTotal}</span>
          )}
          <span className="font-mono text-[9px] text-faint/60">{key}</span>
        </span>
      )}
    </button>
  )

  return (
    <nav
      className={cx(
        'shrink-0 flex flex-col border-r border-edge transition-all',
        collapsed ? 'w-16' : 'w-56',
        ambientWindow ? 'bg-transparent' : 'bg-panel/60'
      )}
    >
      {/* macOS traffic-light inset + wordmark; draggable like a title bar */}
      <div className={cx('drag-region pt-11 pb-5', collapsed ? 'px-0 text-center' : 'px-5')}>
        <button
          onClick={() => setInfoOpen(true)}
          data-tip={update ? `About TastyTunes — v${update.version} available` : 'About TastyTunes'}
          aria-label="About TastyTunes"
          className="no-drag relative font-display font-bold text-[19px] leading-none tracking-tight cursor-pointer"
        >
          {collapsed ? (
            <>
              t<span className="text-gold">t</span>
            </>
          ) : (
            <>
              tasty<span className="text-gold">tunes</span>
            </>
          )}
          {update && (
            // no-drag + a 16px hit box: the dot pokes outside the button's
            // rect into the title-bar drag region, where un-exempted pixels
            // grab the window instead of clicking.
            <span
              aria-label="Update available"
              className="no-drag absolute -top-1.5 -right-4 w-4 h-4 flex items-center justify-center"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-gold" />
            </span>
          )}
        </button>
        {/* demo-mode marker doubles as the exit — the Device screen's
            Disconnect works too, but this makes leaving obvious */}
        {!collapsed && connection.phase !== 'idle' && connection.demo && (
          // tip-bottom + explicit z: the default right-side tip lands on the
          // main area's screen title (and loses the paint-order fight there)
          <button
            onClick={() => void tt.disconnect()}
            data-tip="You're in the demo — click to exit"
            aria-label="Exit demo"
            className="no-drag tip-bottom z-[70] ml-2 align-[3px] px-1.5 py-0.5 rounded-md ring-1 ring-gold/40 bg-golddim font-mono text-[9px] uppercase tracking-widest text-gold hover:brightness-110 motion-safe:active:scale-95 transition-all"
          >
            demo
          </button>
        )}
      </div>

      <div className={cx('flex-1 space-y-0.5', collapsed ? 'px-2' : 'px-3')}>
        {NAV_SCREENS.map(navItem)}
      </div>

      {/* mini player + settings pinned at the bottom, collapse last */}
      <div className={cx('space-y-0.5 pb-3', collapsed ? 'px-2' : 'px-3')}>
        {/* visible entry point for the palette — the shortcut teaches itself */}
        <button
          onClick={() => setPaletteOpen(true)}
          data-tip={`Command palette (${MOD}K)`}
          aria-label={`Command palette (${MOD}K)`}
          className={cx(
            'w-full flex items-center rounded-lg h-9 text-[13.5px] text-dim hover:text-ink hover:bg-veil transition-colors',
            collapsed ? 'justify-center px-0' : 'gap-3 px-3'
          )}
        >
          <Command size={16} strokeWidth={1.8} className="shrink-0" />
          {!collapsed && (
            <span className="flex-1 min-w-0 flex items-center gap-3 overflow-hidden whitespace-nowrap">
              <span className="flex-1 text-left">Commands</span>
              <span className="font-mono text-[9px] text-faint/60">{MOD}K</span>
            </span>
          )}
        </button>
        <button
          onClick={() => void tt.toggleMini()}
          data-tip="Mini player"
          aria-label="Mini player"
          className={cx(
            'w-full flex items-center rounded-lg h-9 text-[13.5px] text-dim hover:text-ink hover:bg-veil transition-colors',
            collapsed ? 'justify-center px-0' : 'gap-3 px-3'
          )}
        >
          <PictureInPicture2 size={16} strokeWidth={1.8} className="shrink-0" />
          {!collapsed && (
            <span className="flex-1 min-w-0 overflow-hidden whitespace-nowrap text-left">
              Mini player
            </span>
          )}
        </button>
        {navItem(SETTINGS_SCREEN)}
        <button
          onClick={() => void toggleCollapsed()}
          data-tip={collapsed ? 'Expand menu' : 'Collapse menu'}
          aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
          className={cx(
            'w-full flex items-center rounded-lg h-9 text-[13.5px] text-faint hover:text-dim hover:bg-veil transition-colors',
            collapsed ? 'justify-center px-0' : 'gap-3 px-3'
          )}
        >
          {collapsed ? (
            <PanelLeftOpen size={16} strokeWidth={1.8} className="shrink-0" />
          ) : (
            <PanelLeftClose size={16} strokeWidth={1.8} className="shrink-0" />
          )}
          {!collapsed && (
            <span className="flex-1 min-w-0 overflow-hidden whitespace-nowrap text-left">
              Collapse
            </span>
          )}
        </button>
      </div>
    </nav>
  )
}
