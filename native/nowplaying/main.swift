// TastyTunes Now Playing: the helper that makes TastyTunes the Mac's playing app.
//
// The app's main process starts this windowless helper while the Media keys setting is on, and
// talks to it over stdio, one line each way per message. It tells macOS what the streamer is
// playing (MPNowPlayingInfoCenter) and passes on the media keys, Control Center's buttons and a
// headset's button (MPRemoteCommandCenter). No audio device is opened and no Accessibility
// permission is needed. A separate process keeps the shared command center away from Chromium's
// own media handling inside the app.
//
// Out (one line each): "hello tastytunes-nowplaying 1" once, at start; "cmd <toggle|play|pause|
// next|previous|stop>"; "cmd seek <seconds>"; "activate" when the tile is clicked; "log <text>".
// In (one JSON object per line): {"t":"info", title, artist, album, duration?, elapsed?,
// playing, live, art?, can: {toggle, next, previous, seek, stop}} or {"t":"release"}.
//
// Built with the Swift 5 language mode (scripts/build-nowplaying.mjs): MediaPlayer calls the
// artwork handler off the main thread, which Swift 6's main-actor rules would stop the process on.
import AppKit
import MediaPlayer

setvbuf(stdout, nil, _IONBF, 0)

let PROTOCOL = 1
let center = MPNowPlayingInfoCenter.default()
let commands = MPRemoteCommandCenter.shared()
var armed = false
var lastArtPath: String? = nil
var lastArt: MPMediaItemArtwork? = nil

func say(_ line: String) { print(line) }

struct Abilities: Decodable {
  let toggle: Bool
  let next: Bool
  let previous: Bool
  let seek: Bool
  let stop: Bool
}

struct Message: Decodable {
  let t: String
  let title: String?
  let artist: String?
  let album: String?
  let duration: Double?
  let elapsed: Double?
  let playing: Bool?
  let live: Bool?
  let art: String?
  let can: Abilities?
}

/// Handlers on, so the keys and Control Center reach us; each command enabled only where the
/// source can do it (no skipping or scrubbing on radio).
func arm(_ can: Abilities) {
  commands.togglePlayPauseCommand.isEnabled = can.toggle
  commands.playCommand.isEnabled = can.toggle
  commands.pauseCommand.isEnabled = can.toggle
  commands.nextTrackCommand.isEnabled = can.next
  commands.previousTrackCommand.isEnabled = can.previous
  commands.changePlaybackPositionCommand.isEnabled = can.seek
  commands.stopCommand.isEnabled = can.stop
  if armed { return }
  armed = true
  commands.togglePlayPauseCommand.addTarget { _ in say("cmd toggle"); return .success }
  commands.playCommand.addTarget { _ in say("cmd play"); return .success }
  commands.pauseCommand.addTarget { _ in say("cmd pause"); return .success }
  commands.nextTrackCommand.addTarget { _ in say("cmd next"); return .success }
  commands.previousTrackCommand.addTarget { _ in say("cmd previous"); return .success }
  commands.stopCommand.addTarget { _ in say("cmd stop"); return .success }
  commands.changePlaybackPositionCommand.addTarget { event in
    if let e = event as? MPChangePlaybackPositionCommandEvent { say("cmd seek \(e.positionTime)") }
    return .success
  }
}

/// Let go: clear, say stopped, and REMOVE the handlers. Saying stopped or disabling the commands
/// does not hand the keys back to another app; removing the handlers does.
func release() {
  center.nowPlayingInfo = nil
  center.playbackState = .stopped
  for c in [
    commands.togglePlayPauseCommand, commands.playCommand, commands.pauseCommand,
    commands.nextTrackCommand, commands.previousTrackCommand, commands.stopCommand,
    commands.changePlaybackPositionCommand,
  ] {
    c.removeTarget(nil)
  }
  armed = false
  lastArtPath = nil
  lastArt = nil
}

func publish(_ m: Message) {
  arm(m.can ?? Abilities(toggle: true, next: false, previous: false, seek: false, stop: false))
  var info: [String: Any] = [:]
  if let v = m.title { info[MPMediaItemPropertyTitle] = v }
  if let v = m.artist { info[MPMediaItemPropertyArtist] = v }
  if let v = m.album { info[MPMediaItemPropertyAlbumTitle] = v }
  if m.live == true {
    info[MPNowPlayingInfoPropertyIsLiveStream] = true
  } else {
    if let v = m.duration { info[MPMediaItemPropertyPlaybackDuration] = v }
    if let v = m.elapsed { info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = v }
  }
  let playing = m.playing ?? false
  info[MPNowPlayingInfoPropertyPlaybackRate] = playing ? 1.0 : 0.0
  if let path = m.art, path != lastArtPath {
    lastArtPath = path
    if let image = NSImage(contentsOfFile: path) {
      lastArt = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
    } else {
      lastArt = nil
    }
  }
  if let a = lastArt { info[MPMediaItemPropertyArtwork] = a }
  center.nowPlayingInfo = info
  let state: MPNowPlayingPlaybackState = playing ? .playing : .paused
  if center.playbackState != state { center.playbackState = state }
}

/// A click on the Now Playing tile brings the "playing app" forward: for a helper that means
/// asking the app to show its window.
final class Delegate: NSObject, NSApplicationDelegate {
  func applicationDidBecomeActive(_ notification: Notification) { say("activate") }
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    say("activate")
    return false
  }
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
say("hello tastytunes-nowplaying \(PROTOCOL)")

DispatchQueue.global().async {
  let decoder = JSONDecoder()
  while let line = readLine() {
    guard let data = line.data(using: .utf8), let m = try? decoder.decode(Message.self, from: data)
    else {
      say("log unreadable line")
      continue
    }
    DispatchQueue.main.async {
      switch m.t {
      case "info": publish(m)
      case "release": release()
      default: say("log unknown message \(m.t)")
      }
    }
  }
  // the app closed the pipe: it quit or let the helper go
  exit(0)
}
app.run()
