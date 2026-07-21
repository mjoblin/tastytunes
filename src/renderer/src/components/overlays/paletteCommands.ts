import {
  AlarmClock,
  ArrowUpCircle,
  AudioLines,
  Bluetooth,
  Bot,
  Cable,
  Disc3,
  HardDrive,
  Heart,
  Info,
  Keyboard,
  Library,
  ListOrdered,
  Maximize2,
  MicVocal,
  Monitor,
  Moon,
  PictureInPicture2,
  Play,
  Power,
  Radio,
  RefreshCw,
  Repeat,
  Search,
  Shuffle,
  SkipBack,
  SkipForward,
  Square,
  Sun,
  Terminal,
  Usb,
  Sparkles,
  UserRound,
  Volume2,
  VolumeX,
} from "lucide-react";
import { SCENES } from "@/components/display/scenes";
import { sleepTrackKey, type SleepAction } from "@shared/model";
import { favoriteKey, type Favorite } from "@shared/model";
import { activatePlaylist } from "@/lib/playlists";
import { audioCaps, brightnessOptions } from "@shared/smoip";
import { toggleFavorite } from "@/lib/favorites";
import { tt } from "@/api";
import { useStore } from "@/store";
import { systemTheme } from "@/hooks/useTheme";
import { activeSourceId, controlSet, deriveNowPlaying } from "@/lib/format";
import { SCREENS, sanitizeNavHidden, sanitizeNavHiddenTools } from "@/lib/screens";
import { SLEEP_DURATIONS } from "@/components/playback/SleepTimer";

// The command palette's COMMANDS as one pure builder (2026-09-13, the size
// survey's last round; the list had been a 602-line memo inside the component):
// what the palette offers for a given state — playback, screens, sources,
// presets, playlists, the sleep timer, power, devices, the view, search, the
// library index, the Settings deep links and the device extras — with the
// command shape, the empty-query section order, the source icon and the
// fuzzy matcher beside it. The component keeps the store reads, the memo and
// the list.

export type Icon = typeof Play;

export interface Command {
  id: string;
  label: string;
  /** Section header and fallback right-hand tag. */
  group: string;
  /** Overrides the group as the right-hand tag (e.g. "Preset 3", "EVO150"). */
  hint?: string;
  icon: Icon;
  keywords?: string;
  /** Screen commands only: this screen is hidden from the sidebar (still navigable here). */
  hidden?: boolean;
  run(): void;
}

// Empty-query section order — most-reached first.
export const GROUP_ORDER = [
  "Playback",
  "Screens",
  "Sources",
  "Presets",
  "Sleep timer",
  "Power",
  "Devices",
  "View",
];

export function sourceIcon(klass: string): Icon {
  if (/bluetooth/i.test(klass)) return Bluetooth;
  if (/radio/i.test(klass)) return Radio;
  if (/usb/i.test(klass)) return Usb;
  return Cable;
}

/**
 * Contiguous-substring or in-order subsequence match. Returns a score (higher =
 * better) or null for no match. Substrings beat subsequences; earlier and
 * more-clustered matches rank higher.
 */
export function fuzzyScore(q: string, text: string): number | null {
  if (!q) return 0;
  const idx = text.indexOf(q);
  if (idx >= 0) return 1000 - idx;
  // The subsequence fallback exists for abbreviation typing ("nptrk",
  // "tnotb", "nplay") — at 1–2 characters it is near-vacuous, so short
  // queries match by substring only.
  if (q.length < 3) return null;
  // Camel-hump rule: a matched character must either START A WORD (previous
  // char is a non-word boundary — space, ·, -, /) or CONTIGUOUSLY EXTEND the
  // previous match. Scattered single letters across a long haystack no
  // longer qualify — e.g. "muse" stops subsequence-matching entries whose
  // keywords contain "musicbrainz … context" (m-u-s ride "mus", but the
  // trailing e was stranded in "cont-e-xt"). Pure initials ("tnotb") and
  // word-prefix runs ("nplay" → Now Playing) still resolve.
  const isWordStart = (pos: number): boolean => pos === 0 || !/[a-z0-9]/.test(text[pos - 1]);
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    // first occurrence at/after ti that is contiguous or a word start
    let found = text.indexOf(ch, ti);
    while (found >= 0 && found !== ti && !isWordStart(found)) {
      found = text.indexOf(ch, found + 1);
    }
    if (found < 0) return null;
    streak = found === ti ? streak + 1 : 0;
    score += 1 + streak;
    ti = found + 1;
  }
  return score;
}

type Store = ReturnType<typeof useStore.getState>;

/** What the builder reads: the store's state and actions the commands use,
 *  and the three values the component derives from the connection. */
export type CommandContext = Pick<
  Store,
  | "saveSettings"
  | "setScreen"
  | "setDiagnosticsOpen"
  | "setShortcutsOpen"
  | "setInfoOpen"
  | "setDisplayMode"
  | "setLyricsOpen"
  | "setArtistOpen"
  | "setContextTab"
  | "systemPower"
  | "sources"
  | "presets"
  | "devices"
  | "zoneState"
  | "playState"
  | "nowPlaying"
  | "sleep"
  | "displayMode"
  | "audioSpec"
  | "favorites"
  | "playlists"
  | "settings"
  | "displaySpec"
  | "mediaIndex"
  | "jumpToSettingsTab"
  | "requestLibrarySearch"
  | "requestSearch"
  | "showToast"
> & {
  connected: boolean;
  inStandby: boolean;
  currentHost: string | null;
};

export function buildCommands(ctx: CommandContext): Command[] {
  const {
    saveSettings,
    setScreen,
    setDiagnosticsOpen,
    setShortcutsOpen,
    setInfoOpen,
    setDisplayMode,
    setLyricsOpen,
    setArtistOpen,
    setContextTab,
    systemPower,
    sources,
    presets,
    devices,
    zoneState,
    playState,
    nowPlaying,
    sleep,
    displayMode,
    audioSpec,
    favorites,
    playlists,
    settings,
    displaySpec,
    mediaIndex,
    jumpToSettingsTab,
    requestLibrarySearch,
    requestSearch,
    showToast,
    connected,
    inStandby,
    currentHost,
  } = ctx;
  const cmds: Command[] = [];
  const controls = controlSet(nowPlaying);
  const allow = (verb: string): boolean => controls.size === 0 || controls.has(verb);

  // -------- Playback (needs a live, awake streamer)
  if (connected && !inStandby) {
    const playing = playState?.state === "play";
    cmds.push({
      id: "toggle",
      label: playing ? "Pause" : "Play",
      group: "Playback",
      icon: Play,
      keywords: "play pause toggle",
      run: () => void tt.command({ type: "togglePlayback" }),
    });
    if (allow("track_next"))
      cmds.push({
        id: "next",
        label: "Next track",
        group: "Playback",
        icon: SkipForward,
        keywords: "skip forward",
        run: () => void tt.command({ type: "nextTrack" }),
      });
    if (allow("track_previous"))
      cmds.push({
        id: "prev",
        label: "Previous track",
        group: "Playback",
        icon: SkipBack,
        keywords: "skip back",
        run: () => void tt.command({ type: "previousTrack" }),
      });
    if (allow("stop"))
      cmds.push({
        id: "stop",
        label: "Stop",
        group: "Playback",
        icon: Square,
        run: () => void tt.command({ type: "stop" }),
      });
    const muted = zoneState?.mute ?? false;
    cmds.push({
      id: "mute",
      label: muted ? "Unmute" : "Mute",
      group: "Playback",
      icon: muted ? VolumeX : Volume2,
      run: () => void tt.command({ type: "setMute", mute: !muted }),
    });
    if (allow("toggle_shuffle")) {
      const on = playState?.mode_shuffle === "all";
      cmds.push({
        id: "shuffle",
        label: on ? "Shuffle off" : "Shuffle on",
        group: "Playback",
        icon: Shuffle,
        run: () => void tt.command({ type: "setShuffle", mode: on ? "off" : "all" }),
      });
    }
    if (allow("toggle_repeat")) {
      const on = playState?.mode_repeat === "all";
      cmds.push({
        id: "repeat",
        label: on ? "Repeat off" : "Repeat all",
        group: "Playback",
        icon: Repeat,
        run: () => void tt.command({ type: "setRepeat", mode: on ? "off" : "all" }),
      });
    }
  }

  // -------- Screens (always available — hidden-from-sidebar screens included,
  // flagged so the row shows they won't appear in the nav)
  const navHidden = new Set(sanitizeNavHidden(settings.navHidden));
  for (const sc of SCREENS) {
    cmds.push({
      id: `screen:${sc.id}`,
      label: sc.label,
      group: "Screens",
      hint: `Screen · ${sc.key}`,
      icon: sc.icon,
      keywords: navHidden.has(sc.id)
        ? "go to open view screen hidden sidebar nav"
        : "go to open view screen",
      hidden: navHidden.has(sc.id),
      run: () => setScreen(sc.id),
    });
  }

  // -------- Sources
  // Sources lost its nav row in the Device merge (2026-07-25), so the palette
  // carries the way TO the surface as well as the direct switches below —
  // a rarely-used screen shouldn't get harder to find for having moved.
  // Writing deviceTab is what clicking the tab does, so the pick persists the
  // same way either route is taken.
  cmds.push({
    id: "device:sources",
    label: "Open Sources",
    group: "View",
    icon: Cable,
    keywords: "device input switch source",
    run: () => {
      void saveSettings({ deviceTab: "sources" });
      setScreen("device");
    },
  });
  if (connected && !inStandby) {
    const activeId = activeSourceId(zoneState, nowPlaying);
    const selectable = (sources?.sources ?? [])
      .filter((s) => s.ui_selectable)
      .sort((a, b) => a.preferred_order - b.preferred_order);
    for (const src of selectable) {
      if (src.id === activeId) continue;
      cmds.push({
        id: `source:${src.id}`,
        label: `Switch to ${src.name}`,
        group: "Sources",
        hint: "Source",
        icon: sourceIcon(src.class),
        keywords: `${src.id} input`,
        run: () => void tt.command({ type: "setSource", sourceId: src.id }),
      });
    }
  }

  // -------- Presets (by name)
  if (connected && !inStandby) {
    for (const p of presets?.presets ?? []) {
      if (p.id == null || !p.name) continue;
      cmds.push({
        id: `preset:${p.id}`,
        label: p.name,
        group: "Presets",
        hint: `Preset ${p.id}`,
        icon: Radio,
        keywords: "recall station",
        run: () => void tt.command({ type: "recallPreset", presetId: p.id as number }),
      });
    }
  }

  // -------- Playlists (by name)
  // The palette listed every PRESET by name but no playlists, which read as
  // an oversight rather than a decision once playlists became the larger
  // feature. activatePlaylist carries its own toast (including the
  // "n not found" case and an Open Queue action), which is exactly right
  // here: the palette leaves you nowhere near the effect.
  if (connected && !inStandby) {
    for (const pl of playlists) {
      if (!pl.name) continue;
      cmds.push({
        id: `playlist:${pl.id}`,
        label: pl.name,
        group: "Playlists",
        hint: `${pl.items.length} ${pl.items.length === 1 ? "track" : "tracks"}`,
        icon: ListOrdered,
        keywords: "playlist activate load queue",
        run: () => void activatePlaylist(pl),
      });
    }
  }

  // -------- Sleep timer
  if (connected && !inStandby) {
    const action: SleepAction =
      settings.sleepAction === "pause" || settings.sleepAction === "standby"
        ? settings.sleepAction
        : "standby";
    const verb = action === "standby" ? "Standby" : "Pause";
    for (const d of SLEEP_DURATIONS) {
      cmds.push({
        id: `sleep:${d.minutes}`,
        label: `Sleep in ${d.label}`,
        group: "Sleep timer",
        hint: verb,
        icon: Moon,
        keywords: "timer countdown",
        run: () =>
          void tt.setSleep({
            action,
            minutes: d.minutes,
            firesAt: Date.now() + d.minutes * 60_000,
            trackKey: null,
          }),
      });
    }
    const meta = deriveNowPlaying(playState, nowPlaying);
    const duration =
      playState?.metadata?.duration ?? nowPlaying?.display?.progress?.duration ?? null;
    if (sleepTrackKey(playState) != null && duration != null && duration > 0 && !meta.isRadio) {
      cmds.push({
        id: "sleep:eot",
        label: "Sleep at end of track",
        group: "Sleep timer",
        hint: verb,
        icon: Moon,
        keywords: "timer end of track",
        run: () =>
          void tt.setSleep({
            action,
            minutes: null,
            firesAt: null,
            trackKey: sleepTrackKey(playState),
          }),
      });
    }
    if (sleep) {
      cmds.push({
        id: "sleep:cancel",
        label: "Cancel sleep timer",
        group: "Sleep timer",
        icon: Moon,
        keywords: "disable off",
        run: () => void tt.setSleep(null),
      });
    }
  }

  // -------- Power
  if (connected) {
    if (systemPower?.power === "ON") {
      cmds.push({
        id: "power:standby",
        label: "Standby",
        group: "Power",
        icon: Power,
        keywords: "sleep network off",
        run: () => void tt.command({ type: "power", power: "NETWORK" }),
      });
    } else {
      cmds.push({
        id: "power:on",
        label: "Power on",
        group: "Power",
        icon: Power,
        keywords: "wake turn on",
        run: () => void tt.command({ type: "power", power: "ON" }),
      });
    }
  }

  // -------- Devices (switch / connect)
  for (const d of devices) {
    if (d.host === currentHost) continue;
    cmds.push({
      id: `device:${d.host}`,
      label: `${connected ? "Switch to" : "Connect to"} ${d.friendlyName}`,
      group: "Devices",
      hint: d.model,
      icon: HardDrive,
      keywords: `${d.host} streamer`,
      run: () => void tt.connect(d.host),
    });
  }

  // -------- View / app
  // Mirror the hidden-from-sidebar hint the hidden screens get: when the
  // Mini player nav button is hidden, flag its palette row too (still runs).
  const miniHiddenFromNav = sanitizeNavHiddenTools(settings.navHiddenTools).includes("mini-player");
  cmds.push({
    id: "view:mini",
    label: "Toggle mini player",
    group: "View",
    icon: PictureInPicture2,
    keywords: miniHiddenFromNav ? "miniplayer window hidden sidebar" : "miniplayer window",
    hidden: miniHiddenFromNav,
    run: () => void tt.toggleMini(),
  });
  if (connected && !inStandby) {
    cmds.push({
      id: "view:display",
      label: displayMode ? "Exit display mode" : "Full-screen display mode",
      group: "View",
      hint: "F",
      icon: Maximize2,
      keywords: "fullscreen wall",
      run: () => setDisplayMode(!displayMode),
    });
    // the scenes by name: pick one and display mode opens on it
    for (const sc of SCENES)
      cmds.push({
        id: `view:scene:${sc.id}`,
        label: `Display scene: ${sc.label}`,
        group: "View",
        icon: Sparkles,
        keywords: `visualizer visual screensaver scene ${sc.blurb}`,
        run: () => {
          void saveSettings({ displayScene: sc.id });
          if (!displayMode) setDisplayMode(true);
        },
      });
  }
  // The drawers live on Now Playing — running these navigates there first.
  // Same metadata gating as the screen's header buttons (no radio, needs artist).
  if (connected && !inStandby) {
    const npMeta = deriveNowPlaying(playState, nowPlaying);
    if (settings.lyrics && !npMeta.isRadio && npMeta.title && npMeta.subtitle) {
      cmds.push({
        id: "view:lyrics",
        label: "Lyrics",
        group: "View",
        icon: MicVocal,
        keywords: "lyrics panel words song",
        run: () => {
          setScreen("now-playing");
          setLyricsOpen(true);
        },
      });
    }
    if (settings.artistInfo && !npMeta.isRadio && npMeta.subtitle) {
      cmds.push({
        id: "view:artist",
        label: "About the artist",
        group: "View",
        icon: UserRound,
        keywords: "artist bio wikipedia musicbrainz context",
        run: () => {
          setScreen("now-playing");
          setContextTab("artist");
          setArtistOpen(true);
        },
      });
    }
    // Heart the current track — same content-only entry as the Now Playing
    // header heart (tracks need title+artist; radio hearts live there only,
    // since they also need the session's lastStation URL).
    if (!npMeta.isRadio && npMeta.title && npMeta.subtitle) {
      const fav = {
        kind: "track" as const,
        title: npMeta.title,
        artist: npMeta.subtitle,
        album: npMeta.album ?? null,
        artUrl: npMeta.artUrl ?? null,
        serverUdn: null,
        serverName: null,
        objectId: null,
        titlePath: null,
        durationSecs: playState?.metadata?.duration ?? null,
      };
      const active = favorites.some((f) => favoriteKey(f) === favoriteKey(fav as Favorite));
      cmds.push({
        id: "view:favtrack",
        label: active ? "Unfavorite this track" : "Favorite this track",
        group: "Playback",
        icon: Heart,
        keywords: "heart favorite like love save track",
        run: () => void toggleFavorite(fav),
      });
    }
    if (settings.artistInfo && !npMeta.isRadio && npMeta.subtitle && npMeta.album) {
      cmds.push({
        id: "view:album",
        label: "About the album",
        group: "View",
        icon: Disc3,
        keywords: "album release year label credits context",
        run: () => {
          setScreen("now-playing");
          setContextTab("album");
          setArtistOpen(true);
        },
      });
    }
    if (settings.artistInfo && !npMeta.isRadio && npMeta.subtitle && npMeta.title) {
      cmds.push({
        id: "view:track",
        label: "About the track",
        group: "View",
        icon: AudioLines,
        keywords: "track credits performers musicians personnel writers context",
        run: () => {
          setScreen("now-playing");
          setContextTab("track");
          setArtistOpen(true);
        },
      });
    }
  }
  // Toggle from the RESOLVED theme (the stored preference may be 'system');
  // running it always writes an explicit theme, which is what a toggle means.
  const shownTheme = settings.theme === "system" ? systemTheme() : settings.theme;
  cmds.push({
    id: "view:theme",
    label: shownTheme === "dark" ? "Switch to light theme" : "Switch to dark theme",
    group: "View",
    icon: shownTheme === "dark" ? Sun : Moon,
    keywords: "appearance dark light",
    run: () => {
      void (async () => {
        await saveSettings({ theme: shownTheme === "dark" ? "light" : "dark" });
      })();
    },
  });
  // Gated exactly like the Device-screen section: only when this streamer's
  // spec advertises writable tone controls (per-model feature detection).
  if (connected && audioCaps(audioSpec)) {
    cmds.push({
      id: "view:toneeq",
      label: "Tone & EQ",
      group: "View",
      icon: AudioLines,
      keywords: "equalizer eq tilt balance tone bass treble dsp",
      run: () => {
        // land on the right Device tab, not just the screen
        void saveSettings({ deviceTab: "tone" });
        setScreen("device");
      },
    });
  }
  cmds.push({
    id: "view:diagnostics",
    label: "Open SMOIP payload console",
    group: "View",
    hint: "`",
    icon: Terminal,
    keywords: "diagnostics debug frames",
    run: () => setDiagnosticsOpen(true),
  });
  cmds.push({
    id: "view:shortcuts",
    label: "Keyboard shortcuts",
    group: "View",
    hint: "?",
    icon: Keyboard,
    run: () => setShortcutsOpen(true),
  });
  cmds.push({
    id: "view:about",
    label: "About TastyTunes",
    group: "View",
    icon: Info,
    keywords: "support version info",
    run: () => setInfoOpen(true),
  });

  // -------- Search: the pair reads together — "everything" is the app-wide
  // -------- screen, "the library" is the library's own deeper search.
  cmds.push({
    id: "search:everything",
    label: "Search everything",
    group: "Library",
    icon: Search,
    keywords: "find music search unified radio playlists presets favorites everywhere",
    run: () => requestSearch(),
  });
  // -------- Library search + index (the media-index feature set)
  if (connected) {
    cmds.push({
      id: "library:search",
      label: "Search the library",
      group: "Library",
      icon: Search,
      keywords: "find music album artist track search deep",
      run: () => requestLibrarySearch(),
    });
  }
  for (const idx of mediaIndex) {
    if (idx.state === "building") continue;
    cmds.push({
      id: `library:rebuild:${idx.udn}`,
      label: `${idx.state === "ready" ? "Rebuild" : "Build"} the ${idx.serverName} library index`,
      group: "Library",
      icon: RefreshCw,
      keywords: "index scan media server refresh",
      run: () => {
        void tt.mediaIndexRebuild(idx.udn);
        // palette-site feedback: the building spinner lives in Settings →
        // Libraries, invisible from wherever the palette left you
        showToast({
          kind: "success",
          text: `${idx.state === "ready" ? "Rebuilding" : "Building"} the ${idx.serverName} index. Progress shows in Settings › Libraries.`,
        });
      },
    });
  }

  // -------- Settings deep links (the nav-dot jump mechanism, reused)
  cmds.push({
    id: "settings:updates",
    label: "Open Updates",
    group: "View",
    icon: ArrowUpCircle,
    keywords: "settings version upgrade release",
    run: () => jumpToSettingsTab("updates"),
  });
  cmds.push({
    id: "settings:libraries",
    label: "Open Libraries",
    group: "View",
    icon: Library,
    keywords: "settings media index servers",
    run: () => jumpToSettingsTab("libraries"),
  });
  cmds.push({
    id: "settings:schedules",
    label: "Open Schedules",
    group: "View",
    icon: AlarmClock,
    keywords: "settings alarm wake timer automation schedule",
    run: () => jumpToSettingsTab("schedules"),
  });
  cmds.push({
    id: "settings:agents",
    label: "Open AI agents",
    group: "View",
    icon: Bot,
    keywords: "settings mcp tools model context protocol",
    run: () => jumpToSettingsTab("agents"),
  });
  // store builds: the App Store owns delivery — no update-check affordance
  // anywhere, the palette included (main-side checkUpdatesOnDemand also
  // refuses, but the entry shouldn't exist)
  if (!tt.storeBuild)
    cmds.push({
      id: "update:check",
      label: "Check for updates",
      group: "View",
      icon: ArrowUpCircle,
      keywords: "version new release upgrade now",
      run: () => {
        // land where the outcome shows, then ask
        jumpToSettingsTab("updates");
        void tt.updateCheckNow();
      },
    });

  // -------- Device extras (spec-gated exactly like the Device screen)
  if (connected) {
    const brightness = brightnessOptions(displaySpec);
    if (brightness) {
      const LABEL: Record<string, string> = { off: "off", dim: "dim", bright: "bright" };
      for (const level of brightness) {
        cmds.push({
          id: `display:${level}`,
          label: `Display ${LABEL[level] ?? level}`,
          group: "Device",
          icon: Monitor,
          keywords: "brightness front panel screen",
          run: () => void tt.command({ type: "setBrightness", brightness: level }),
        });
      }
    }
    if (audioCaps(audioSpec)) {
      for (const preset of settings.eqPresets) {
        cmds.push({
          id: `eq:${preset.name}`,
          label: `EQ preset: ${preset.name}`,
          group: "Device",
          icon: AudioLines,
          keywords: "equalizer tone sound apply",
          run: () => {
            void (async () => {
              await tt.command({ type: "setUserEq", enabled: true });
              await tt.command({ type: "setEqBands", gains: preset.gains });
              showToast({ kind: "success", text: `EQ preset ${preset.name} applied.` });
            })();
          },
        });
      }
    }
  }

  return cmds;
}
