import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/instrument-sans'
import '@fontsource/spline-sans-mono/400.css'
import '@fontsource/spline-sans-mono/500.css'
// the curated display-font set (Settings → Appearance); only the active
// face's woff2 is ever fetched
import '@fontsource-variable/fraunces'
import '@fontsource-variable/space-grotesk'
import '@fontsource-variable/sora'
import '@fontsource-variable/unbounded'
import './styles.css'

import React, { Suspense, lazy } from 'react'
import ReactDOM from 'react-dom/client'
import { tt } from './api'
import { useStore } from './store'

// Split at the one natural seam: the always-on-top mini strip used to parse
// the ENTIRE app bundle (all screens, dnd-kit, the palette) and the main
// window parsed the mini right back. Each window now loads only its chunk.
const App = lazy(() => import('./App'))
const MiniPlayer = lazy(() =>
  import('./components/MiniPlayer').then((m) => ({ default: m.MiniPlayer }))
)

// Subscribe to pushes before fetching the snapshot so nothing slips between them.
// Menu clicks carry side effects (settings round-trips) that don't fit
// applyPush's pure state merge, so they route to their own action.
tt.onPush((msg) => {
  if (msg.kind === 'menu') useStore.getState().applyMenu(msg.command)
  else useStore.getState().applyPush(msg)
})
void tt.getSnapshot().then((snapshot) => useStore.getState().init(snapshot))

// The mini-player window loads the same bundle with ?mini=1.
const isMini = new URLSearchParams(window.location.search).has('mini')
if (isMini) document.documentElement.classList.add('mini')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Suspense fallback={null}>{isMini ? <MiniPlayer /> : <App />}</Suspense>
  </React.StrictMode>
)
