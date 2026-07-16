import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/instrument-sans'
import '@fontsource/spline-sans-mono/400.css'
import '@fontsource/spline-sans-mono/500.css'
import './styles.css'

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { MiniPlayer } from './components/MiniPlayer'
import { tt } from './api'
import { useStore } from './store'

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
  <React.StrictMode>{isMini ? <MiniPlayer /> : <App />}</React.StrictMode>
)
