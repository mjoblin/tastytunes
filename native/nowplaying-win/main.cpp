// TastyTunes Now Playing for Windows: the helper that makes TastyTunes Windows' playing app.
//
// The app's main process starts this console-less helper while the Media keys setting is on and
// talks to it over stdio, the same protocol as the Mac helper (native/nowplaying): one line each
// way per message. It shows what the streamer is playing in Windows' media controls (the media
// flyout, the lock screen) through a MediaPlayer's SystemMediaTransportControls with its command
// manager off, so no audio is ever played, and passes on the media keys and the flyout's buttons.
// It takes the app's identity (the AppUserModelID the installer's shortcut carries), so Windows
// names the session TastyTunes, with its icon.
//
// Out: "hello tastytunes-nowplaying 1" once; "cmd <toggle|play|pause|next|previous|stop>";
// "cmd seek <seconds>"; "log <text>". In: {"t":"info", title, artist, album, duration?, elapsed?,
// playing, live, art?, can: {toggle, next, previous, seek, stop}} or {"t":"release"}.
#include <windows.h>
#include <shobjidl_core.h>
#include <cstdio>
#include <iostream>
#include <mutex>
#include <string>

#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <winrt/Windows.Media.h>
#include <winrt/Windows.Media.Playback.h>
#include <winrt/Windows.Storage.h>
#include <winrt/Windows.Storage.Streams.h>

using namespace winrt;
using namespace winrt::Windows::Data::Json;
using namespace winrt::Windows::Foundation;
using namespace winrt::Windows::Media;
using namespace winrt::Windows::Media::Playback;
using namespace winrt::Windows::Storage;
using namespace winrt::Windows::Storage::Streams;

static std::mutex out_lock;

static void say(const std::string& line) {
  std::lock_guard<std::mutex> g(out_lock);
  std::fputs(line.c_str(), stdout);
  std::fputs("\n", stdout);
  std::fflush(stdout);
}

static std::string utf8(const hstring& s) { return to_string(s); }

static hstring field(const JsonObject& o, const wchar_t* key) {
  if (!o.HasKey(key)) return L"";
  auto v = o.GetNamedValue(key);
  return v.ValueType() == JsonValueType::String ? v.GetString() : hstring{};
}

static bool flag(const JsonObject& o, const wchar_t* key) {
  if (!o.HasKey(key)) return false;
  auto v = o.GetNamedValue(key);
  return v.ValueType() == JsonValueType::Boolean && v.GetBoolean();
}

static bool number(const JsonObject& o, const wchar_t* key, double& out) {
  if (!o.HasKey(key)) return false;
  auto v = o.GetNamedValue(key);
  if (v.ValueType() != JsonValueType::Number) return false;
  out = v.GetNumber();
  return true;
}

int wmain() {
  init_apartment(apartment_type::multi_threaded);
  // the app's identity, so Windows names the session TastyTunes (the installer's shortcut)
  SetCurrentProcessExplicitAppUserModelID(L"com.redactedcat.tastytunes");

  MediaPlayer player;
  player.CommandManager().IsEnabled(false);
  auto smtc = player.SystemMediaTransportControls();
  smtc.IsEnabled(false);
  smtc.ButtonPressed([](auto const&, SystemMediaTransportControlsButtonPressedEventArgs const& e) {
    switch (e.Button()) {
      case SystemMediaTransportControlsButton::Play: say("cmd play"); break;
      case SystemMediaTransportControlsButton::Pause: say("cmd pause"); break;
      case SystemMediaTransportControlsButton::Next: say("cmd next"); break;
      case SystemMediaTransportControlsButton::Previous: say("cmd previous"); break;
      case SystemMediaTransportControlsButton::Stop: say("cmd stop"); break;
      default: break;
    }
  });
  smtc.PlaybackPositionChangeRequested(
      [](auto const&, PlaybackPositionChangeRequestedEventArgs const& e) {
        double secs = std::chrono::duration<double>(e.RequestedPlaybackPosition()).count();
        say("cmd seek " + std::to_string(secs));
      });

  say("hello tastytunes-nowplaying 1");

  std::wstring lastArt;
  std::string line;
  while (std::getline(std::cin, line)) {
    try {
      JsonObject m;
      if (!JsonObject::TryParse(to_hstring(line), m)) {
        say("log unreadable line");
        continue;
      }
      auto t = field(m, L"t");
      if (t == L"release") {
        // letting go: the session leaves Windows' media controls, and the keys with it
        smtc.PlaybackStatus(MediaPlaybackStatus::Closed);
        smtc.DisplayUpdater().ClearAll();
        smtc.DisplayUpdater().Update();
        smtc.IsEnabled(false);
        lastArt.clear();
        continue;
      }
      if (t != L"info") {
        say("log unknown message " + utf8(t));
        continue;
      }
      auto can = m.HasKey(L"can") ? m.GetNamedObject(L"can") : JsonObject();
      bool toggle = flag(can, L"toggle");
      smtc.IsEnabled(true);
      smtc.IsPlayEnabled(toggle);
      smtc.IsPauseEnabled(toggle);
      smtc.IsNextEnabled(flag(can, L"next"));
      smtc.IsPreviousEnabled(flag(can, L"previous"));
      smtc.IsStopEnabled(flag(can, L"stop"));
      auto du = smtc.DisplayUpdater();
      du.Type(MediaPlaybackType::Music);
      du.MusicProperties().Title(field(m, L"title"));
      du.MusicProperties().Artist(field(m, L"artist"));
      du.MusicProperties().AlbumTitle(field(m, L"album"));
      std::wstring art{field(m, L"art")};
      if (art != lastArt) {
        lastArt = art;
        if (!art.empty()) {
          try {
            auto file = StorageFile::GetFileFromPathAsync(art).get();
            du.Thumbnail(RandomAccessStreamReference::CreateFromFile(file));
          } catch (...) {
            du.Thumbnail(nullptr);
          }
        } else {
          du.Thumbnail(nullptr);
        }
      }
      du.Update();
      double duration = 0, elapsed = 0;
      bool live = flag(m, L"live");
      SystemMediaTransportControlsTimelineProperties tl;
      if (!live && number(m, L"duration", duration)) {
        tl.StartTime(TimeSpan{0});
        tl.MinSeekTime(TimeSpan{0});
        tl.EndTime(std::chrono::duration_cast<TimeSpan>(std::chrono::duration<double>(duration)));
        tl.MaxSeekTime(tl.EndTime());
        if (number(m, L"elapsed", elapsed))
          tl.Position(std::chrono::duration_cast<TimeSpan>(std::chrono::duration<double>(elapsed)));
        smtc.UpdateTimelineProperties(tl);
      }
      smtc.PlaybackStatus(flag(m, L"playing") ? MediaPlaybackStatus::Playing
                                              : MediaPlaybackStatus::Paused);
    } catch (hresult_error const& e) {
      say("log error " + utf8(e.message()));
    } catch (...) {
      say("log error");
    }
  }
  // the app closed the pipe: it quit or let the helper go
  return 0;
}
