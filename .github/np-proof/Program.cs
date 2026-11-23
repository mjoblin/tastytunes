// THROWAWAY PROOF (spike/windows-np): can a desktop app with no audio appear in Windows' media
// controls, and receive the media keys there? The answer decides whether TastyTunes gets a Windows
// Now Playing helper in 0.17.0. It registers a session through a MediaPlayer's transport controls
// (the route the xosms module uses, no window handle), plays nothing, lists the sessions Windows
// reports, then presses play/pause twice: once as the keyboard's key, once as the flyout's button.
using System.Runtime.InteropServices;
using Windows.Media;
using Windows.Media.Control;
using Windows.Media.Playback;

static class Proof
{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SetCurrentProcessExplicitAppUserModelID(string id);

    [DllImport("user32.dll")]
    static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    const byte VK_MEDIA_PLAY_PAUSE = 0xB3;
    const uint KEYEVENTF_KEYUP = 0x2;

    static async Task<int> Main()
    {
        var withId = Environment.GetEnvironmentVariable("NP_AUMID");
        if (!string.IsNullOrEmpty(withId))
            Console.WriteLine($"AUMID set: {SetCurrentProcessExplicitAppUserModelID(withId) == 0} ({withId})");

        var presses = new List<string>();
        var player = new MediaPlayer();
        player.CommandManager.IsEnabled = false;
        var smtc = player.SystemMediaTransportControls;
        smtc.IsEnabled = true;
        smtc.IsPlayEnabled = true;
        smtc.IsPauseEnabled = true;
        smtc.IsNextEnabled = true;
        smtc.IsPreviousEnabled = true;
        smtc.ButtonPressed += (_, e) => { lock (presses) presses.Add(e.Button.ToString()); };
        var du = smtc.DisplayUpdater;
        du.Type = MediaPlaybackType.Music;
        du.MusicProperties.Title = "Proof track";
        du.MusicProperties.Artist = "TastyTunes";
        du.MusicProperties.AlbumTitle = "No audio";
        du.Update();
        smtc.PlaybackStatus = MediaPlaybackStatus.Playing;
        Console.WriteLine("registered: playing, no audio opened");
        await Task.Delay(2000);

        var mgr = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
        var sessions = mgr.GetSessions();
        Console.WriteLine($"sessions Windows reports: {sessions.Count}");
        GlobalSystemMediaTransportControlsSession? ours = null;
        foreach (var s in sessions)
        {
            var p = await s.TryGetMediaPropertiesAsync();
            Console.WriteLine($"  session app={s.SourceAppUserModelId} title={p?.Title} artist={p?.Artist} status={s.GetPlaybackInfo()?.PlaybackStatus}");
            if (p?.Title == "Proof track") ours = s;
        }
        var current = mgr.GetCurrentSession();
        Console.WriteLine($"current session: {current?.SourceAppUserModelId ?? "none"}");

        keybd_event(VK_MEDIA_PLAY_PAUSE, 0, 0, UIntPtr.Zero);
        keybd_event(VK_MEDIA_PLAY_PAUSE, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        await Task.Delay(2000);
        lock (presses) Console.WriteLine($"after the keyboard's play/pause: [{string.Join(", ", presses)}]");

        if (ours != null)
        {
            var ok = await ours.TryTogglePlayPauseAsync();
            await Task.Delay(1500);
            lock (presses) Console.WriteLine($"after the flyout's play/pause (accepted {ok}): [{string.Join(", ", presses)}]");
        }

        var found = ours != null;
        Console.WriteLine($"RESULT session listed: {found}; presses received: {presses.Count}");
        return found ? 0 : 1;
    }
}
