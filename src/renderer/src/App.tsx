import { useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, Loader2, Moon, Power, Search, Sparkles, X } from "lucide-react";
import { RECONNECT_GRACE_MS, type KnownDevice } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";
import { useShortcuts } from "@/hooks/useShortcuts";
import { useIndexingToast } from "@/hooks/useIndexingToast";
import { useWakeHold } from "@/hooks/useWakeHold";
import { useArtAccent } from "@/hooks/useArtAccent";
import { useArtLoadable } from "@/hooks/useArtLoadable";
import { useMotionPreference } from "@/hooks/useMotionPreference";
import { useTheme } from "@/hooks/useTheme";
import { useDisplayFont } from "@/hooks/useDisplayFont";
import { cx, deriveNowPlaying } from "@/lib/format";
import { forgetDevice, lastSeenLabel } from "@/lib/devices";
import { useConfirmPopover } from "@/components/chrome/Confirm";
import { Nav } from "@/components/Nav";
import { PlaybackBar } from "@/components/playback/PlaybackBar";
import { DiagnosticsDrawer } from "@/components/overlays/DiagnosticsDrawer";
import { ShortcutsOverlay } from "@/components/overlays/ShortcutsOverlay";
import { CommandPalette } from "@/components/overlays/CommandPalette";
import { InfoModal } from "@/components/overlays/InfoModal";
import { MediaInfoModal } from "@/components/overlays/MediaInfoModal";
import { DisplayMode } from "@/components/playback/DisplayMode";
import { NowPlayingScreen } from "@/screens/NowPlayingScreen";
import { QueueScreen } from "@/screens/QueueScreen";
import { PresetsScreen } from "@/screens/PresetsScreen";
import { LibraryScreen } from "@/screens/LibraryScreen";
import { RadioScreen } from "@/screens/RadioScreen";
import { RecentlyPlayedScreen } from "@/screens/RecentlyPlayedScreen";
import { FavoritesScreen } from "@/screens/FavoritesScreen";
import { PlaylistsScreen } from "@/screens/PlaylistsScreen";
import { DeviceScreen } from "@/screens/DeviceScreen";
import { SearchScreen } from "@/screens/SearchScreen";
import { SettingsScreen } from "@/screens/SettingsScreen";
import { AmbientArt } from "@/components/media/AmbientArt";
import { useDecodedArt } from "@/hooks/useDecodedArt";
import { usePrefetchNextArt } from "@/hooks/usePrefetchNextArt";
import { useFontScaleGuard } from "@/hooks/useFontScaleGuard";
import { HeaderChip } from "@/components/chrome/Chrome";

export default function App(): React.JSX.Element {
  useShortcuts();
  useIndexingToast();

  const screen = useStore((s) => s.screen);
  const connection = useStore((s) => s.connection);
  const systemPower = useStore((s) => s.systemPower);
  const playState = useStore((s) => s.playState);
  const nowPlaying = useStore((s) => s.nowPlaying);
  const diagnosticsOpen = useStore((s) => s.diagnosticsOpen);
  const mediaInfo = useStore((s) => s.mediaInfo);
  const paletteOpen = useStore((s) => s.paletteOpen);
  const displayMode = useStore((s) => s.displayMode);
  const setDisplayMode = useStore((s) => s.setDisplayMode);

  const settings = useStore((s) => s.settings);

  const connected = connection.phase === "connected";
  // The wake window: power ON is not arrival. The whole story — the retained
  // re-announcement, the two wake paths, the release rules and why the first
  // version of this hold regressed — lives in useWakeHold; this file just
  // asks. `waking` is the wake-on-intent flag; `holding` covers the gap
  // between the wake finishing and the streamer actually arriving.
  const waking = useStore((s) => s.waking);
  const holding = useWakeHold();
  const systemPowerFresh = useStore((s) => s.systemPowerFresh);
  const inStandby =
    connected &&
    ((systemPowerFresh && systemPower != null && systemPower.power !== "ON") || waking || holding);

  // Per-album accent tint (Plexamp-style), from the current art.
  const theme = useTheme(settings.theme);
  useDisplayFont(settings.displayFont);
  const meta = deriveNowPlaying(playState, nowPlaying);
  const artActive = connected && !inStandby ? meta.artUrl : null;
  // A dead art URL must not leave the ambient wash/vignette up with no art.
  const artLoadable = useArtLoadable(artActive);
  // The wash renders the last DECODED art, so a slow remote cover can't blank
  // the window while it downloads (see useDecodedArt).
  const { art: ambientArtUrl } = useDecodedArt(artActive);
  useArtAccent(settings.accentFollowsArt ? artActive : null, theme);
  useMotionPreference(settings.motion);
  // Queue playback knows the next track's art before it's needed — warm it so
  // the swap is instant on album/playlist runs.
  usePrefetchNextArt();
  // Dev tripwire: nested .font-display would compound the optical zoom.
  useFontScaleGuard(screen);

  useEffect(() => {
    if (!connected && displayMode) setDisplayMode(false);
  }, [connected, displayMode, setDisplayMode]);

  const ambientVisible =
    ambientArtUrl != null &&
    artLoadable &&
    (settings.ambientArt === "all" ||
      (settings.ambientArt === "now-playing" && screen === "now-playing"));

  // Full-window ambient: the nav/bar drop their panel tint so the wash is even.
  const setAmbientWindowActive = useStore((s) => s.setAmbientWindowActive);
  const ambientWindow = ambientVisible && settings.ambientCoverage === "window";
  useEffect(() => {
    setAmbientWindowActive(ambientWindow);
  }, [ambientWindow, setAmbientWindowActive]);

  const content = (() => {
    if (screen === "device") return <DeviceScreen />;
    if (screen === "settings") return <SettingsScreen />;
    // Recently played is local history — viewable even while disconnected/standby.
    if (screen === "recently-played") return <RecentlyPlayedScreen />;
    // Favorites is a local collection too — browsable offline; play verbs
    // surface their own failures through the central toast.
    if (screen === "favorites") return <FavoritesScreen />;
    // Playlists are local user data — browsable while disconnected, like
    // Favorites and Recently Played. Activating one needs the streamer; the
    // screen's Play button is what surfaces that, not a wall.
    if (screen === "playlists") return <PlaylistsScreen />;
    // Search spans local collections as well as the streamer, so it stays
    // usable offline — the library/radio groups simply answer with nothing and
    // the rows that need a device dim themselves.
    if (screen === "search") return <SearchScreen />;
    if (!connected) return <ConnectGate />;
    // Standby is a PRESENCE, not a wall (probed 2026-07-23: every state
    // endpoint, art path, and WS subscribe still answers in NETWORK
    // standby) — screens stay browsable and play actions wake the device
    // (wake-on-intent in DeviceManager). Only Now Playing, which genuinely
    // has nothing to show, gets the sleeping face.
    switch (screen) {
      case "now-playing":
        return inStandby ? <StandbyGate busy={waking || holding} /> : <NowPlayingScreen />;
      case "queue":
        return <QueueScreen />;
      case "presets":
        return <PresetsScreen />;
      case "library":
        return <LibraryScreen />;
      case "radio":
        return <RadioScreen />;
    }
  })();

  // Always mounted (with a null src when it shouldn't show) so the wash can
  // fade out on its own instead of vanishing in a frame.
  const ambient = (
    <AmbientArt
      src={ambientVisible ? (ambientArtUrl ?? null) : null}
      vignette={settings.vignette}
    />
  );
  const coverWindow = settings.ambientCoverage === "window";

  return (
    <div className="relative h-full">
      {/* full-window ambient art, behind the translucent chrome */}
      {coverWindow && ambient}

      <div className="relative h-full flex flex-col">
        <div className="flex-1 flex min-h-0 relative">
          <Nav />
          <main className="flex-1 min-w-0 min-h-0 relative">
            {/* main-area-only ambient art, behind the screen content */}
            {!coverWindow && ambient}
            <div className="relative h-full">{content}</div>
            {diagnosticsOpen && <DiagnosticsDrawer />}
            <ToastHost />
          </main>
        </div>
        <PlaybackBar />
        {displayMode && <DisplayMode />}
        {/* The modals stay mounted and take their open state themselves —
            the shell's exit fade needs the DOM to outlive the close. */}
        <ShortcutsOverlay />
        {paletteOpen && <CommandPalette />}
        <InfoModal />
        <MediaInfoModal target={mediaInfo} />
      </div>
    </div>
  );
}

/**
 * The single transient-feedback slot (see ToastData in the store). Bottom-
 * center above the playback bar; click dismisses, and the optional action
 * either jumps to the screen where the effect lives or undoes what just
 * happened (see ToastAction). Deliberately NOT wired to Escape — the Escape
 * cascade belongs to overlays.
 */
function ToastHost(): React.JSX.Element | null {
  const toast = useStore((s) => s.toast);
  const dismissToast = useStore((s) => s.dismissToast);
  const setScreen = useStore((s) => s.setScreen);

  useEffect(() => {
    if (!toast) return;
    // Errors linger a little longer than confirmations; an UNDO offer longer
    // still (half again), because it isn't there to be read — it's there to be
    // decided on, and noticing "wait, I didn't mean that" takes a beat.
    const ms = toast.action?.undo ? 5400 : toast.kind === "error" ? 5000 : 3600;
    const t = setTimeout(dismissToast, ms);
    return () => clearTimeout(t);
  }, [toast, dismissToast]);

  if (!toast) return null;
  return (
    <div key={toast.id} className="toast-in absolute bottom-4 left-1/2 -translate-x-1/2 z-40">
      <div
        onClick={dismissToast}
        style={
          {
            "--toast-accent": toast.kind === "error" ? "var(--alert-rgb)" : "var(--gold-rgb)",
          } as React.CSSProperties
        }
        className={cx(
          // Translucent + blurred rather than an opaque slab: the toast floats
          // over content and the ambient art wash, and a solid bg-raised panel
          // read as pasted ON the app rather than part of it. Letting the warm
          // near-black bg through is what makes it feel lit from the same
          // source as everything else. Roomier too — px-5/py-3, and gap-3 with
          // the action pushed further out so it stops crowding the sentence.
          "toast-surface flex items-center gap-3 rounded-xl px-5 py-3 ring-1 backdrop-blur-md",
          "bg-panel/70 shadow-[0_10px_40px_rgb(0_0_0_/_0.55)] text-[12.5px] cursor-pointer max-w-[520px]",
          toast.kind === "error"
            ? "ring-alert/45"
            : "ring-gold/35 shadow-[0_10px_40px_rgb(0_0_0_/_0.55),0_0_24px_rgb(var(--gold-rgb)_/_0.10)]",
        )}
      >
        {toast.kind === "error" ? (
          <CircleAlert size={14} className="text-alert shrink-0" />
        ) : (
          <CircleCheck size={14} className="text-gold shrink-0" />
        )}
        <span className="flex-1 min-w-0">{toast.text}</span>
        {toast.action && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              const action = toast.action!;
              if (action.undo) action.undo();
              else setScreen(action.screen);
              dismissToast();
            }}
            // Tinted to the toast's own accent so it reads as the thing to
            // click. Neutral ring + text-dim over a translucent surface came
            // out looking like a disabled field.
            className={cx(
              "ml-2 shrink-0 text-[12px] px-3 py-1.5 rounded-md ring-1 font-medium transition-all",
              toast.kind === "error"
                ? "ring-alert/40 text-alert hover:bg-alert/10 hover:ring-alert/60"
                : "ring-gold/35 text-gold hover:bg-golddim hover:ring-gold/55",
            )}
          >
            {toast.action.label}
          </button>
        )}
      </div>
    </div>
  );
}

/** Shown on streamer screens while there's no live connection. */
function ConnectGate(): React.JSX.Element {
  const connection = useStore((s) => s.connection);
  const devices = useStore((s) => s.devices);
  const discovering = useStore((s) => s.discovering);
  const setScreen = useStore((s) => s.setScreen);
  // Forgetting is the one unreconstructible act on this screen — an eco
  // streamer that's off can't re-teach itself until it next wakes — and a
  // tester lost one to a stray click (rc.1, 2026-08-31). The anchored
  // popover, never the in-place morph: the × must not move under the cursor.
  const forgetConfirm = useConfirmPopover();
  const knownDevices = useStore((s) => s.settings.knownDevices);
  const lastHost = useStore((s) => s.settings.lastHost);
  // Never connected to anything = a true first run: the gate doubles as the
  // welcome screen (connect() stamps lastHost on the first attempt).
  const firstRun = lastHost == null;
  // If the device we lost had ECO standby configured, the honest hint is
  // that it may have LEFT THE NETWORK on purpose (eco powers the network
  // interface down — probed 2026-07-23; app-wake is impossible there).
  const maybeEco = useStore((s) => s.lastStandbyMode === "ECO_MODE");

  const busy =
    connection.phase === "connecting" ||
    (connection.phase === "disconnected" && connection.reconnecting);

  // A failing reconnect gets RECONNECT_GRACE_MS of benefit of the doubt (a
  // blip should read as a blip), then the gate stops being a wall: the
  // retry demotes to a status line and the full surface — found streamers,
  // remembered streamers, manual entry — comes back. Eco standby skips the
  // doubt: eco powers the network off, so the device is not coming back on
  // its own (the multi-streamer eco report, 2026-08-30). The reconnect
  // itself keeps running underneath; if the device returns, it still wins.
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!busy) {
      setStuck(false);
      return;
    }
    if (maybeEco) {
      setStuck(true);
      return;
    }
    const t = setTimeout(() => setStuck(true), RECONNECT_GRACE_MS);
    return () => clearTimeout(t);
  }, [busy, maybeEco]);

  // Count completed sweeps so the manual-IP hint can surface after a few
  // misses. (The periodic re-sweep itself lives in DeviceManager now — it
  // must run whether or not this gate is mounted and unwalled.)
  const [sweeps, setSweeps] = useState(0);
  const prevDiscovering = useRef(discovering);
  useEffect(() => {
    if (prevDiscovering.current && !discovering) setSweeps((n) => n + 1);
    prevDiscovering.current = discovering;
  }, [discovering]);
  const stillLooking = !busy && devices.length === 0 && sweeps >= 3;

  // The device book: remembered streamers the sweep has NOT confirmed render
  // dimmed under the live results, connectable on faith (the address usually
  // survives a power cycle) and forgettable — Bluetooth semantics, except a
  // forgotten device that answers a later sweep reappears as a plain
  // discovery: memory is deletable, live truth is not.
  // ONE list, keyed by identity, with CONSTANT geometry for remembered
  // streamers: a book member's card carries its last-seen line and its ×
  // whether or not the sweep can see it right now, so sliding between
  // "answering" and "remembered" changes only the card's brightness — which
  // transition-colors already fades. The first cut let the third line come
  // and go with liveness and the card resized with every sweep (user,
  // 2026-08-30). Only a never-connected stranger gets the two-line card,
  // and a stranger never transitions to remembered (only connecting writes
  // the book, and a connect leaves this gate).
  const foundUdns = new Set(devices.map((d) => d.udn).filter(Boolean));
  const bookByUdn = new Map(knownDevices.map((d) => [d.udn, d]));
  const gateRows = [
    ...devices.map((d) => ({
      key: d.udn || d.host,
      live: true,
      friendlyName: d.friendlyName,
      model: d.model,
      host: d.host,
      book: (d.udn ? bookByUdn.get(d.udn) : null) ?? (null as KnownDevice | null),
    })),
    ...knownDevices
      .filter((d) => !foundUdns.has(d.udn))
      .map((d) => ({
        key: d.udn,
        live: false,
        friendlyName: d.friendlyName,
        model: d.model,
        host: d.host,
        book: d,
      })),
  ];

  return (
    <div className="h-full flex flex-col items-center justify-center gap-5 text-center px-8">
      {maybeEco && (
        <div
          data-eco-hint
          className="flex items-center gap-2 text-[12.5px] text-amber/90 border border-amber/20 bg-amberdim/40 rounded-full px-4 py-1.5"
        >
          <Moon size={12} strokeWidth={2} />
          The streamer may be in eco standby — eco turns its network off, so wake it at the device.
        </div>
      )}
      {busy && !stuck ? (
        <>
          <Loader2 size={40} className="spin text-amber" />
          <div className="font-display text-xl text-dim">
            {connection.phase === "connecting"
              ? `Connecting to ${connection.host}…`
              : `Reconnecting to ${(connection as { host: string }).host}…`}
          </div>
        </>
      ) : (
        <>
          {firstRun ? (
            <>
              <div className="font-display font-bold text-[34px] leading-none tracking-tight">
                tasty<span className="text-gold">tunes</span>
              </div>
              <div className="text-[14px] text-dim max-w-md leading-relaxed">
                The hi-fi remote for Cambridge Audio StreamMagic streamers. Streamers on your
                network appear here on their own.
              </div>
            </>
          ) : (
            <>
              <Search size={48} strokeWidth={1.2} className="text-faint/60" />
              <div className="font-display text-2xl text-dim">No streamer connected</div>
            </>
          )}
          {busy && stuck && (
            <div data-still-trying className="flex items-center gap-2 text-[12.5px] text-faint">
              <Loader2 size={12} className="spin" />
              Still trying {(connection as { host: string }).host} — it may be off or in eco
              standby.
            </div>
          )}
          {gateRows.length > 0 ? (
            <div className="space-y-2">
              {gateRows.map((row) => (
                <div
                  key={row.key}
                  data-known-device={row.live ? undefined : row.key}
                  className={cx(
                    "relative w-72 rounded-xl ring-1 ring-edge transition-colors",
                    row.live ? "bg-panel hover:bg-raised" : "bg-panel/60 hover:bg-raised/70",
                  )}
                >
                  <button
                    onClick={() => void tt.connect(row.host)}
                    className={cx("block w-full px-4 py-3 text-left", row.book && "pr-10")}
                  >
                    <div className={cx("text-[13.5px]", !row.live && "text-dim")}>
                      {row.friendlyName}
                    </div>
                    {/* Stacked on purpose — in a 288px card these wrap mid-
                        phrase as one line, and a deliberate stack reads
                        calmer than an accidental wrap (user, 2026-08-30). */}
                    <div className="font-mono text-[10.5px] text-faint truncate">
                      {row.model} · {row.host}
                    </div>
                    {row.book && (
                      <div className="font-mono text-[10.5px] text-faint">
                        last seen {lastSeenLabel(row.book.lastSeenAt)}
                      </div>
                    )}
                  </button>
                  {row.book && (
                    <button
                      onClick={(e) =>
                        forgetConfirm.ask(e, {
                          question: `Forget “${row.friendlyName}”? It won't be remembered again until it's next seen on the network.`,
                          verb: "Forget",
                          onConfirm: () => forgetDevice(row.book!),
                        })
                      }
                      data-forget-device={row.key}
                      aria-label={`Forget ${row.friendlyName}`}
                      data-tip={`Forget ${row.friendlyName}`}
                      className="tip-bottom tip-end absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-full text-faint hover:text-ink hover:bg-veil2 motion-safe:active:scale-90 transition-all"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              ))}
              {forgetConfirm.popover}
            </div>
          ) : (
            <div className="text-[13px] text-faint max-w-sm">
              {discovering ? "Searching the network…" : "No StreamMagic devices found yet."}
            </div>
          )}
          {stillLooking && (
            <div className="text-[12.5px] text-faint max-w-sm leading-relaxed">
              Still looking — the search repeats on its own. If the streamer sits on a different
              subnet or Wi-Fi band, enter its IP manually below.
            </div>
          )}
          <div className="flex items-center gap-4">
            <button
              onClick={() => void tt.discover()}
              disabled={discovering}
              // Fixed width: the label alternates with the background sweep
              // and the row must not breathe with it (user, 2026-08-30).
              className="min-w-[128px] text-center text-[13px] px-4 py-2 rounded-lg bg-amber text-bg font-medium hover:brightness-110 transition-all disabled:opacity-50"
            >
              {discovering ? "Searching…" : "Find devices"}
            </button>
            <HeaderChip
              onClick={() => setScreen("device")}
              className="text-[13px] px-4 py-2 motion-safe:active:scale-95"
            >
              Enter IP manually →
            </HeaderChip>
          </div>
          <button
            onClick={() => void tt.demoStart()}
            className="mt-4 flex items-center gap-2 text-[13px] text-faint hover:text-dim transition-colors"
          >
            <Sparkles size={14} className="text-gold/70" />
            Try without a streamer — explore with the built-in demo →
          </button>
        </>
      )}
    </div>
  );
}

/** Now Playing while the streamer sleeps: nothing is playing, so the screen
 *  becomes a quiet face — wake lamp, last played, and the standing offer.
 *
 *  `busy` is the whole wake window — the `waking` flag PLUS the hold that
 *  covers the gap between the wake finishing and the streamer arriving (see
 *  useWakeHold). The copy keys on it so the face reads asleep → Waking… →
 *  gone; keying on `waking` alone made it read asleep → Waking… → asleep
 *  again for the seconds the recall was still in flight (the reported
 *  flip-flop).
 */
function StandbyGate({ busy }: { busy: boolean }): React.JSX.Element {
  const systemInfo = useStore((s) => s.systemInfo);
  const last = useStore((s) => s.recents[0]);

  return (
    <div
      data-standby-face
      className="h-full flex flex-col items-center justify-center gap-6 text-center px-8"
    >
      <button
        onClick={() => void tt.command({ type: "power", power: "ON" })}
        className={cx(
          "h-24 w-24 rounded-full ring-2 ring-amber/50 text-amber flex items-center justify-center",
          "hover:bg-amberdim hover:shadow-[0_0_40px_rgb(var(--amber-rgb)_/_0.35)] transition-all",
          busy && "motion-safe:animate-pulse bg-amberdim",
        )}
        title="Power on"
      >
        <Power size={36} strokeWidth={1.8} />
      </button>
      {/* EVERY LINE HOLDS ITS HEIGHT whether or not it has content — the face
          is a centred flex column, so a line that unmounts re-centres the
          whole stack and the lamp visibly jumps as the copy changes. This was
          fixed once, lost, and reported again (2026-08-03); the tray panel's
          standby face reserves all three lines for the same reason. */}
      <div>
        <div className="font-display text-2xl text-dim flex items-center justify-center gap-2.5 min-h-[32px]">
          <Moon size={20} strokeWidth={1.8} className="text-amber/70" />
          {systemInfo?.name ?? "Streamer"} is asleep
        </div>
        <div className="text-[13px] text-faint mt-1.5 min-h-[19px]">
          {busy ? "Waking…" : "Press the lamp — or just play something, from any screen."}
        </div>
        <div className="text-[12px] text-faint mt-4 min-h-[17px]">
          {last != null && (
            <>
              Last played:{" "}
              <span className="text-dim">
                {last.title ?? last.station}
                {last.artist ? ` — ${last.artist}` : ""}
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
