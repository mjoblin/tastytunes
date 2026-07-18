// Capacitor shell config (spike). Typed loosely because @capacitor/cli isn't
// installed yet — swap to `import type { CapacitorConfig } from '@capacitor/cli'`
// when the port phase adds the Capacitor deps.
//
// Doctrine notes encoded here (ROADMAP R5 touch-feel):
// - backgroundColor matches the app's dark bg so launch/rotation never
//   flashes white (classic webby tell #1). Pair with a launch storyboard of
//   the same color at `cap add ios` time.
// - No server.url: the renderer ships in the bundle (capacitor://localhost),
//   which is also the Origin the Evo's /smoip WebSocket accepts.
const config = {
  // Placeholder — the iOS bundle id is an Apple-side decision (ASC app
  // record); align before the first archive.
  appId: 'com.redactedcat.tastytunes.ipad',
  appName: 'TastyTunes',
  // The desktop renderer build, reused wholesale (electron-vite emits it
  // here); the iPad responsive/touch pass happens in the renderer itself.
  webDir: '../out/renderer',
  backgroundColor: '#0e0d0b',
  ios: {
    contentInset: 'never',
    // WKWebView's UIScrollView keeps native physics — never disable bounce
    // globally; contain overscroll per-surface in CSS instead.
    scrollEnabled: true
  }
}

export default config
