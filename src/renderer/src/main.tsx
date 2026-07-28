import '@fontsource-variable/instrument-sans'
import '@fontsource/spline-sans-mono/400.css'
import '@fontsource/spline-sans-mono/500.css'
// the curated display-font set (Settings → Appearance); only the active
// face's woff2 is ever fetched
import '@fontsource-variable/fraunces'
import '@fontsource-variable/unbounded'
import '@fontsource-variable/newsreader'
import '@fontsource-variable/hanken-grotesk'
import '@fontsource/instrument-serif/400.css'
import '@fontsource-variable/schibsted-grotesk'
import './styles.css'

import React, { Suspense, lazy } from 'react'
import ReactDOM from 'react-dom/client'
import { tt } from './api'
import { useStore } from './store'

// Split at the one natural seam: the always-on-top mini strip used to parse
// the ENTIRE app bundle (all screens, dnd-kit, the palette) and the main
// window parsed the mini right back. Each window now loads only its chunk —
// three of them now, since the tray panel is a third window with a third,
// much smaller, set of needs.
const App = lazy(() => import('./App'))
const MiniPlayer = lazy(() =>
  import('./components/playback/MiniPlayer').then((m) => ({ default: m.MiniPlayer }))
)
const TrayPanel = lazy(() =>
  import('./components/playback/TrayPanel').then((m) => ({ default: m.TrayPanel }))
)

// EVERYTHING AT MODULE SCOPE HERE MUST BE IDEMPOTENT. In dev, edits to
// entry-reachable modules (store, api, this file) hot-update WITHOUT a page
// reload, re-executing this module. React 18+ roots don't clear the
// container, so a second bare createRoot APPENDS a second live tree — the
// orphaned one keeps its window/ipc listeners forever. That was the
// follow-scroll tug-of-war AND arrows stepping the volume N× (one stale tree
// per hot edit). Root and push wiring therefore live in window slots:
// re-execution replaces them instead of stacking.
declare global {
  interface Window {
    __ttRoot?: ReactDOM.Root
    __ttUnwirePush?: () => void
  }
}

// Subscribe to pushes before fetching the snapshot so nothing slips between them.
// Menu clicks carry side effects (settings round-trips) that don't fit
// applyPush's pure state merge, so they route to their own action.
window.__ttUnwirePush?.()
window.__ttUnwirePush = tt.onPush((msg) => {
  if (msg.kind === 'menu') useStore.getState().applyMenu(msg.command)
  else useStore.getState().applyPush(msg)
})
void tt.getSnapshot().then((snapshot) => useStore.getState().init(snapshot))

// Secondary windows load the same bundle with a query flag: ?mini=1 for the
// mini player, ?tray=1 for the tray panel.
const params = new URLSearchParams(window.location.search)
const isMini = params.has('mini')
const isTray = params.has('tray')
if (isMini) document.documentElement.classList.add('mini')
if (isTray) document.documentElement.classList.add('tray')

const root = (window.__ttRoot ??= ReactDOM.createRoot(document.getElementById('root')!))
root.render(
  <React.StrictMode>
    <Suspense fallback={null}>{isTray ? <TrayPanel /> : isMini ? <MiniPlayer /> : <App />}</Suspense>
  </React.StrictMode>
)
