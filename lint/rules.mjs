// The one-home rules and banned patterns (lint/plugin.mjs runs them). Each entry
// was a source-text pin in the invariant suite (its block named in `was`) and
// carries `bad`: code the rule must report in that file, which
// lint/rules.test.mjs runs, along with the same code in an allowed file.
//
//   selector  an ESLint (esquery) selector that must not match
//   files     path regexes the entry applies to (default: all linted files)
//   allow     path regexes where the selector may match (the rule's home)
//
// Paths are repo-relative POSIX paths, tested as regexes.
const R = "src/renderer/src/";
const strings = (re) =>
  `:matches(Literal[value=${re}], TemplateElement[value.raw=${re}], JSXText[value=${re}])`;

export const ONE_HOME = [
  {
    id: "transport-controls",
    was: "S9",
    selector: "CallExpression[callee.name='controlSet']",
    files: [`^${R}`],
    allow: [
      "components/playback/Transport\\.tsx$",
      "lib/format\\.ts$",
      "overlays/paletteCommands\\.ts$",
    ],
    message: "A surface takes its transport controls from useTransport, never from controlSet()",
    bad: { file: `${R}components/playback/MiniPlayer.tsx`, code: "const c = controlSet(np, ps);" },
  },
  {
    id: "preset-is-playing",
    was: "S9",
    selector:
      ":matches(MemberExpression[property.name='is_playing'], ObjectPattern > Property[key.name='is_playing'])",
    files: [`^${R}`],
    allow: ["hooks/useLitPresets\\.ts$"],
    message:
      "A preset's is_playing flag is read only by useLitPresets (it is unreliable both ways)",
    bad: { file: `${R}screens/PresetsScreen.tsx`, code: "const lit = p.is_playing;" },
  },
  {
    id: "eqbars-props",
    was: "S9",
    selector:
      "JSXOpeningElement[name.name='Eqbars'] > JSXAttribute[name.name=/^(playing|audible)$/]",
    files: [`^${R}`],
    message: "Eqbars takes no playing or audible prop; the row's playing state decides",
    bad: { file: `${R}screens/QueueScreen.tsx`, code: "const x = <Eqbars playing />;" },
  },
  {
    id: "modal-open",
    was: "S11",
    selector: "JSXOpeningElement[name.name='ModalShell']:not(:has(JSXAttribute[name.name='open']))",
    message: "ModalShell stays mounted and takes open, or its exit fade pops",
    bad: {
      file: `${R}components/overlays/InfoModal.tsx`,
      code: "const x = <ModalShell label='a'>{c}</ModalShell>;",
    },
  },
  {
    id: "modal-label",
    was: "S100",
    selector:
      "JSXOpeningElement[name.name='ModalShell']:not(:has(JSXAttribute[name.name='label']))",
    message: "Every modal is a named dialog: ModalShell takes label",
    bad: {
      file: `${R}components/overlays/InfoModal.tsx`,
      code: "const x = <ModalShell open>{c}</ModalShell>;",
    },
  },
  {
    id: "frost-no-transition",
    was: "S11",
    selector: strings(String.raw`/(^|[\s'"])transition/`),
    files: [
      "overlays/InfoModal\\.tsx$",
      "overlays/ShortcutsOverlay\\.tsx$",
      "overlays/MediaInfoModal\\.tsx$",
      "controls/CloseButton\\.tsx$",
    ],
    message: "No transition classes inside the frosted modal shell (they re-blur every frame)",
    bad: {
      file: `${R}components/overlays/InfoModal.tsx`,
      code: "const x = <div className='p-2 transition-colors' />;",
    },
  },
  {
    id: "frost-no-transition-preset-panel",
    was: "S11",
    selector: `FunctionDeclaration[id.name='PresetSavePanel'] ${strings(String.raw`/(^|[\s'"])transition/`)}`,
    files: ["library/LibraryMenus\\.tsx$"],
    message: "No transition classes inside the frosted preset panel",
    bad: {
      file: `${R}components/library/LibraryMenus.tsx`,
      code: "function PresetSavePanel() { return <div className='transition-opacity' />; }",
    },
  },
  {
    id: "sleep-durations",
    was: "S21",
    selector:
      "ObjectExpression:has(> Property[key.name='minutes'][value.value=15]):has(> Property[key.name='label'][value.value='15 min'])",
    files: [`^${R}`],
    allow: ["playback/SleepTimer\\.tsx$"],
    message: "The sleep durations are defined once, in SleepTimer (SLEEP_DURATIONS)",
    bad: {
      file: `${R}components/device/DeviceControls.tsx`,
      code: "const d = [{ minutes: 15, label: '15 min' }];",
    },
  },
  {
    id: "user-agent",
    was: "S21",
    selector: String.raw`TemplateElement[value.raw=/TastyTunes\/$/]`,
    files: ["^src/main/"],
    allow: ["^src/main/netlog\\.ts$"],
    message: "The User-Agent is built once, in netlog (USER_AGENT)",
    bad: { file: "src/main/lookups/lyrics.ts", code: "const ua = `TastyTunes/${version}`;" },
  },
  {
    id: "radio-debounce",
    was: "S21",
    selector: "VariableDeclarator[id.name=/DEBOUNCE_MS$/][init.value=350]",
    files: [`^${R}`],
    allow: ["lib/radio\\.ts$"],
    message: "The radio search debounce is RADIO_DEBOUNCE_MS in lib/radio",
    bad: { file: `${R}screens/RadioScreen.tsx`, code: "const RADIO_DEBOUNCE_MS = 350;" },
  },
  {
    id: "signal-colour",
    was: "S25",
    selector:
      ":matches(CallExpression[callee.name='signalGlow'], MemberExpression[object.name='SIGNAL_COLORS'][computed=true])",
    files: [`^${R}`],
    allow: ["device/SignalLamp\\.tsx$", "lib/format\\.ts$"],
    message: "Only SignalLamp paints a signal colour (SignalDot pairs each with a shape)",
    bad: { file: `${R}screens/NowPlayingScreen.tsx`, code: "const g = signalGlow('hires');" },
  },
  {
    id: "card-shell",
    was: "S36",
    selector: `:matches(${strings(String.raw`/bg-raised\/70 ring-1 ring-(edge|gold\/25)/`)}, ${strings(String.raw`/overflow-hidden bg-panel\/70 flex/`)})`,
    files: [
      "library/LibraryCards\\.tsx$",
      "screens/LibraryScreen\\.tsx$",
      "screens/PresetsScreen\\.tsx$",
      "screens/QueueScreen\\.tsx$",
    ],
    message:
      "A media card's shell is bg-raised/50 and its well a veil lift, never /70 or a panel hole",
    bad: {
      file: `${R}screens/QueueScreen.tsx`,
      code: "const x = <div className='bg-raised/70 ring-1 ring-edge' />;",
    },
  },
  {
    id: "retired-names",
    was: "S37, S71, S77",
    selector:
      "Identifier[name=/^(searchBack|SearchBack|searchGoBack|searchFrom|fmtHours|fmtSpan|isDeclined)$/]",
    message:
      "A retired name: the pivot is history now, durations go through fmtDuration, isDeclined became the lookup purpose",
    bad: { file: `${R}screens/SearchScreen.tsx`, code: "const searchBack = 1;" },
  },
  {
    id: "play-pointer",
    was: "S58",
    // optional chaining wraps the member access in a ChainExpression, so both shapes
    selector:
      "LogicalExpression[operator='??']:matches([left.property.name='play_id'], [left.expression.property.name='play_id']):matches([right.property.name='queue_id'], [right.expression.property.name='queue_id'])",
    files: [`^${R}`],
    allow: ["lib/playingEntry\\.ts$"],
    message: "The playing entry's pointer is effectivePlayId (lib/playingEntry), never re-derived",
    bad: {
      file: `${R}screens/QueueScreen.tsx`,
      code: "const id = queue?.play_id ?? playState?.queue_id;",
    },
  },
  {
    id: "tt-wrapper",
    was: "S77",
    selector: `:matches(MemberExpression[property.name='mediaQueueAdd'][object.name='raw'], MemberExpression[property.name='mediaQueueAdd'][object.property.name='tastytunes'], Property[key.name='id'] > MemberExpression[property.name='parentId'], CallExpression[callee.property.name='mediaQueueAdd'] MemberExpression[property.name='parentId'])`,
    files: [`^${R}`],
    allow: ["/api\\.ts$"],
    message: "Queue writes go through the tt wrapper, and never queue a parentId",
    bad: {
      file: `${R}screens/LibraryScreen.tsx`,
      code: "void window.tastytunes.mediaQueueAdd(x);",
    },
  },
  {
    id: "void-command",
    was: "S96",
    selector:
      "UnaryExpression[operator='void'] > CallExpression:matches([callee.name='command'], [callee.property.name='command'])",
    files: ["^src/main/"],
    message: "A command's rejection is caught (DeviceManager.fire), never discarded with void",
    bad: { file: "src/main/app/tray.ts", code: "void dm.command({ type: 'pause' });" },
  },
  {
    id: "ipc-guard",
    was: "S99",
    selector: "MemberExpression[object.name='ipcMain'][property.name=/^(handle|on)$/]",
    files: ["^src/main/"],
    allow: ["^src/main/app/guard\\.ts$"],
    message: "IPC handlers register through app/guard (the sender check), never ipcMain directly",
    bad: { file: "src/main/index.ts", code: "ipcMain.handle('x', () => 1);" },
  },
  {
    id: "dnd-accessibility",
    was: "S105",
    selector:
      "JSXOpeningElement[name.name='DndContext']:not(:has(JSXAttribute[name.name='accessibility'] Identifier[name='DND_ACCESSIBILITY']))",
    files: [`^${R}`],
    message:
      "Every DndContext passes accessibility={DND_ACCESSIBILITY} (its screen-reader text in the body)",
    bad: {
      file: `${R}screens/QueueScreen.tsx`,
      code: "const x = <DndContext sensors={s}>{c}</DndContext>;",
    },
  },
  {
    id: "no-vendor-key",
    was: "S13",
    selector: `:matches(${strings("/asset/i")}, Identifier[name=/asset/i])`,
    files: ["^src/main/media/mediaIndex\\.ts$", "^src/main/media/reconcile\\.ts$"],
    message: "Server rules key on the shape of the data, never a vendor name",
    bad: { file: "src/main/media/reconcile.ts", code: "const v = name === 'Asset';" },
  },
  {
    id: "order-tracks",
    was: "S13",
    selector: "CallExpression[callee.property.name='sort'][arguments.0.name='compareTrackOrder']",
    allow: ["^src/shared/model"],
    message:
      "Album track order goes through orderTracks (it sorts only when disc and position are unique)",
    bad: { file: `${R}screens/LibraryScreen.tsx`, code: "tracks.sort(compareTrackOrder);" },
  },
  {
    id: "toast-in",
    was: "S45",
    selector: strings(String.raw`/\btoast-in\b/`),
    files: [`^${R}`],
    allow: ["^src/renderer/src/App\\.tsx$", "controls/SelectionBar\\.tsx$"],
    message: "The toast-in animation belongs to the toast host and the selection bar",
    bad: { file: `${R}screens/QueueScreen.tsx`, code: "const x = <div className='toast-in' />;" },
  },
  {
    id: "select-all",
    was: "S45",
    selector:
      "BinaryExpression[operator='==='][left.callee.property.name='toLowerCase'][right.value='a']",
    files: [`^${R}`],
    allow: ["library/useRowSelection\\.ts$"],
    message: "Select all (⌘A) has one home, useRowSelection",
    bad: {
      file: `${R}components/queue/useQueueSelection.ts`,
      code: "if (e.key.toLowerCase() === 'a') selectAll();",
    },
  },
  {
    id: "counts",
    was: "S54",
    selector: "CallExpression[callee.property.name='toLocaleString'][arguments.length=0]",
    files: [`^${R}`],
    allow: ["lib/format\\.ts$"],
    message: "Counts print through fmtCount, never a hand-rolled toLocaleString()",
    bad: {
      file: `${R}components/settings/HistorySection.tsx`,
      code: "const s = n.toLocaleString();",
    },
  },
  {
    id: "known-drs",
    was: "S62",
    selector:
      ":matches(CallExpression[callee.property.name=/^audio(Dr|Stats)Many$/], CallExpression[callee.name=/^audio(Dr|Stats)Many$/])",
    files: [`^${R}`],
    allow: ["lib/audioAnalysis\\.ts$", "overlays/MediaInfoModal\\.tsx$"],
    message:
      "Rows and lenses read dynamic range through useKnownDrs, not audioDrMany or audioStatsMany",
    bad: { file: `${R}components/library/lenses/TracksLens.tsx`, code: "void audioDrMany(keys);" },
  },
  {
    id: "media-art-no-best-art",
    was: "S67",
    selector: "CallExpression[callee.name='useBestArt']",
    files: ["media/MediaArt\\.tsx$"],
    message: "MediaArt draws the src it is given; the best art is chosen by its callers",
    bad: { file: `${R}components/media/MediaArt.tsx`, code: "const a = useBestArt(src);" },
  },
  {
    id: "queue-place",
    was: "S103",
    selector: "MemberExpression[property.name='queue_index']",
    files: ["screens/NowPlayingScreen\\.tsx$", "^src/renderer/src/lib/mediaInfo\\.ts$"],
    message: "The place in the queue (or on a disc) comes from queuePlace, its one home",
    bad: { file: `${R}screens/NowPlayingScreen.tsx`, code: "const i = ps.queue_index;" },
  },
  {
    id: "bare-key-accelerator",
    was: "S7",
    selector: "Property[key.name='accelerator'] Literal[value=/^[^+]{1,5}$/]",
    files: ["^src/main/app/menu\\.ts$"],
    message:
      "No bare-key accelerator on a menu item (macOS fires it as well as the renderer's handler)",
    bad: {
      file: "src/main/app/menu.ts",
      code: "const item = { label: 'Display', accelerator: 'F' };",
    },
  },
  {
    id: "notice-dash",
    was: "S76",
    selector: `:matches(CallExpression[callee.name=/^show(Notice|Toast)$/], CallExpression[callee.property.name=/^show(Notice|Toast)$/], NewExpression[callee.name='Notification']) ${strings("/—/")}`,
    message: "No em dash in a notice, toast or notification",
    bad: { file: `${R}App.tsx`, code: "showToast({ text: 'Saved — done' });" },
  },
  {
    id: "history-copy-dash",
    was: "S69, S70, S71, S72, S73",
    selector: strings("/—/"),
    files: [
      "history/HistoryTimeline\\.tsx$",
      "history/HistoryStats\\.tsx$",
      "controls/PickerPill\\.tsx$",
      "^src/shared/historyStats\\.ts$",
      "^src/renderer/src/lib/historyStats\\.ts$",
      "lib/historyStreamers\\.ts$",
    ],
    message: "No em dash in the History views' copy",
    bad: {
      file: `${R}components/history/HistoryStats.tsx`,
      code: "const x = <p>Plays — this week</p>;",
    },
  },
  {
    id: "queue-source",
    was: "none (0.11.0 sweep: eight surfaces derived it by hand from zoneState and nowPlaying)",
    selector:
      "BinaryExpression[operator='==='][left.callee.name='activeSourceId'][right.value='MEDIA_PLAYER']",
    files: [`^${R}`],
    allow: ["hooks/useQueueSourceActive\\.ts$"],
    message:
      "Whether the queue is the audible source is useQueueSourceActive (a boolean selector: no re-render on every zone push)",
    bad: {
      file: `${R}screens/QueueScreen.tsx`,
      code: "const audible = activeSourceId(zoneState, nowPlaying) === 'MEDIA_PLAYER';",
    },
  },
  {
    id: "hand-rolled-cap",
    was: "none (0.11.0 sweep: five module caches capped themselves by hand, first in first out)",
    selector:
      "MemberExpression[property.name='value'][object.callee.property.name='next'][object.callee.object.callee.property.name='keys']",
    files: [`^${R}`],
    allow: ["lib/lru\\.ts$"],
    message:
      "A bounded module cache is an Lru (lib/lru), never a Map that evicts its own oldest key",
    bad: {
      file: `${R}hooks/useArtAccent.ts`,
      code: "if (cache.size > 80) cache.delete(cache.keys().next().value as string);",
    },
  },
  {
    id: "focus-reveal",
    was: "none (0.11.0: Chromium's focus-visible lights after any key, so a reveal on it showed after a click and a hotkey)",
    selector: strings("/focus-visible:/"),
    files: [`^${R}`],
    message:
      "A reveal on keyboard focus is focus-kbd: (it waits for Tab, lib/inputModality), never focus-visible:",
    bad: {
      file: `${R}components/media/RowAction.tsx`,
      code: "const c = 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100';",
    },
  },
  {
    id: "settings-pointer",
    was: "S93",
    selector: strings("/Settings →/"),
    message: "A Settings pointer reads Settings › Tab, never an arrow",
    bad: { file: `${R}screens/RadioScreen.tsx`, code: "const s = 'Settings → Connections';" },
  },
  {
    id: "window-keydown",
    was: "none (0.12.0: the Library's Backspace and the Queue's Delete acted behind the Info window)",
    selector:
      "CallExpression[callee.object.name='window'][callee.property.name='addEventListener'][arguments.0.value='keydown']",
    files: [`^${R}`],
    allow: [
      "lib/keyboardOwner\\.ts$",
      "hooks/useShortcuts\\.ts$",
      "hooks/usePopover\\.ts$",
      "hooks/useNavDrag\\.tsx$",
      "components/controls/Slider\\.tsx$",
      "components/device/ToneEq\\.tsx$",
    ],
    message:
      "A screen hears keys through onScreenKey (lib/keyboardOwner), quiet while a modal has the keyboard",
    bad: {
      file: `${R}screens/QueueScreen.tsx`,
      code: "window.addEventListener('keydown', onKey);",
    },
  },
  {
    id: "scroll-into-view",
    was: "none (docs/renderer.md banned it in prose; HistoryTimeline's month rail still called it, found 2026-10-13)",
    selector: "CallExpression[callee.property.name='scrollIntoView']",
    files: [`^${R}`],
    message:
      "scrollIntoView scrolls every scrollable ancestor, the window too: use lib/scroll's container-scoped helpers",
    bad: {
      file: `${R}components/history/HistoryTimeline.tsx`,
      code: "el.scrollIntoView({ block: 'start' });",
    },
  },
  {
    id: "url-scheme-registration",
    was: "none (0.12.0, the URL scheme: a dev run registering Electron.app would take tastytunes:// from the installed app)",
    selector:
      "CallExpression[callee.property.name=/^(setAsDefaultProtocolClient|removeAsDefaultProtocolClient)$/]",
    allow: ["^src/main/app/urlActions\\.ts$"],
    message:
      "The tastytunes:// scheme is registered only in app/urlActions, and only by a packaged build",
    bad: { file: "src/main/index.ts", code: 'app.setAsDefaultProtocolClient("tastytunes");' },
  },
];
