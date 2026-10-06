import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, EyeOff, Search } from "lucide-react";
import { useStore } from "@/store";
import { cx } from "@/lib/format";
import { scrollToVisible } from "@/lib/scroll";
import {
  type Command,
  GROUP_ORDER,
  buildCommands,
  fuzzyScore,
} from "@/components/overlays/paletteCommands";

export function CommandPalette(): React.JSX.Element {
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  const saveSettings = useStore((s) => s.saveSettings);
  const setScreen = useStore((s) => s.setScreen);
  const setDiagnosticsOpen = useStore((s) => s.setDiagnosticsOpen);
  const setShortcutsOpen = useStore((s) => s.setShortcutsOpen);
  const setInfoOpen = useStore((s) => s.setInfoOpen);
  const setDisplayMode = useStore((s) => s.setDisplayMode);
  const setLyricsOpen = useStore((s) => s.setLyricsOpen);
  const setArtistOpen = useStore((s) => s.setArtistOpen);
  const setContextTab = useStore((s) => s.setContextTab);

  const connection = useStore((s) => s.connection);
  const systemPower = useStore((s) => s.systemPower);
  const sources = useStore((s) => s.sources);
  const presets = useStore((s) => s.presets);
  const devices = useStore((s) => s.devices);
  const zoneState = useStore((s) => s.zoneState);
  const playState = useStore((s) => s.playState);
  const nowPlaying = useStore((s) => s.nowPlaying);
  const sleep = useStore((s) => s.sleep);
  const displayMode = useStore((s) => s.displayMode);
  const audioSpec = useStore((s) => s.audioSpec);
  const favorites = useStore((s) => s.favorites);
  const playlists = useStore((s) => s.playlists);
  const settings = useStore((s) => s.settings);
  const displaySpec = useStore((s) => s.displaySpec);
  const mediaIndex = useStore((s) => s.mediaIndex);
  const jumpToSettingsTab = useStore((s) => s.jumpToSettingsTab);
  const requestLibrarySearch = useStore((s) => s.requestLibrarySearch);
  const requestSearch = useStore((s) => s.requestSearch);
  const showToast = useStore((s) => s.showToast);

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const connected = connection.phase === "connected";
  const inStandby = connected && systemPower != null && systemPower.power !== "ON";
  const currentHost = "host" in connection ? (connection as { host: string }).host : null;

  // the list is one pure builder over the state (paletteCommands, 2026-09-13)
  const commands = useMemo<Command[]>(
    () =>
      buildCommands({
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
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the builder reads the fields listed
    [
      connected,
      inStandby,
      currentHost,
      playState,
      nowPlaying,
      zoneState,
      sources,
      presets,
      devices,
      sleep,
      systemPower,
      displayMode,
      displaySpec,
      mediaIndex,
      audioSpec,
      favorites,
      settings.theme,
      settings.sleepAction,
      settings.lyrics,
      settings.artistInfo,
      settings.navHidden,
      settings.navHiddenTools,
      settings.eqPresets,
      playlists,
      jumpToSettingsTab,
      requestLibrarySearch,
      requestSearch,
      saveSettings,
      showToast,
      setLyricsOpen,
      setArtistOpen,
      setContextTab,
      setScreen,
      setDiagnosticsOpen,
      setShortcutsOpen,
      setInfoOpen,
      setDisplayMode,
    ],
  );

  const q = query.trim().toLowerCase();
  const filtered = useMemo<Command[]>(() => {
    if (!q) {
      return [...commands].sort(
        (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group),
      );
    }
    return commands
      .map((c) => {
        const hay = `${c.label} ${c.hint ?? ""} ${c.group} ${c.keywords ?? ""}`.toLowerCase();
        const labelScore = fuzzyScore(q, c.label.toLowerCase());
        const hayScore = fuzzyScore(q, hay);
        if (labelScore == null && hayScore == null) return null;
        return { c, score: Math.max((labelScore ?? -1) * 2, hayScore ?? -1) };
      })
      .filter((x): x is { c: Command; score: number } => x != null)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c);
  }, [commands, q]);

  // Keep the selection valid as the result set changes.
  useEffect(() => {
    setSelected(0);
  }, [q]);
  useEffect(() => {
    if (selected > filtered.length - 1) setSelected(Math.max(0, filtered.length - 1));
  }, [filtered.length, selected]);

  // Scroll the active row into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-selected="true"]');
    scrollToVisible(el ?? null);
  }, [selected, filtered]);

  const run = (cmd: Command | undefined): void => {
    if (!cmd) return;
    setPaletteOpen(false);
    cmd.run();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(filtered[selected]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setPaletteOpen(false);
    }
  };

  const showHeaders = q === "";
  let lastGroup = "";

  return (
    <div
      className="absolute inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-[12vh]"
      onClick={() => setPaletteOpen(false)}
    >
      <div
        className="w-[560px] max-w-[90vw] rounded-2xl bg-panel ring-1 ring-edge2 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 border-b border-edge">
          <Search size={17} className="text-faint shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a command: transport, sources, presets, screens…"
            className="flex-1 bg-transparent outline-none py-3.5 text-[14px] placeholder:text-faint"
          />
          <span className="microlabel shrink-0">⌘K</span>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-2">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-[13px] text-faint">No matching commands</div>
          ) : (
            filtered.map((cmd, i) => {
              const header = showHeaders && cmd.group !== lastGroup ? cmd.group : null;
              if (header) lastGroup = cmd.group;
              const Icon = cmd.icon;
              const active = i === selected;
              return (
                <div key={cmd.id}>
                  {header && <div className="microlabel px-4 pt-3 pb-1.5">{header}</div>}
                  <button
                    data-selected={active || undefined}
                    onMouseMove={() => setSelected(i)}
                    onClick={() => run(cmd)}
                    className={cx(
                      "w-full flex items-center gap-3 px-4 py-2 text-left transition-colors",
                      active ? "bg-amberdim text-amber" : "text-ink hover:bg-veil",
                    )}
                  >
                    <Icon
                      size={16}
                      strokeWidth={1.8}
                      className={cx("shrink-0", active ? "text-amber" : "text-dim")}
                    />
                    <span className="flex-1 min-w-0 truncate text-[13.5px]">{cmd.label}</span>
                    {cmd.hidden && (
                      <EyeOff
                        size={12}
                        strokeWidth={1.8}
                        aria-label="Hidden from left nav"
                        className="shrink-0 text-faint/70"
                      />
                    )}
                    <span className="shrink-0 font-mono text-[10px] text-faint/80">
                      {cmd.hint ?? cmd.group}
                    </span>
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-4 px-4 py-2 border-t border-edge text-faint">
          <span className="flex items-center gap-1.5 text-[11px]">
            <CornerDownLeft size={12} /> run
          </span>
          <span className="flex items-center gap-1.5 text-[11px] font-mono">↑↓ move</span>
          <span className="flex items-center gap-1.5 text-[11px] font-mono">esc close</span>
          <span className="flex-1" />
          <span className="text-[11px] tabular-nums">{filtered.length}</span>
        </div>
      </div>
    </div>
  );
}
