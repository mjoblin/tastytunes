import type { StreamerCommand, TastyTunesApi } from '@shared/ipc'

const raw: TastyTunesApi = window.tastytunes

/**
 * Failure text for the HTTP-backed write commands — the only ones whose
 * rejections reach the renderer (WebSocket sends are fire-and-forget in the
 * main process). Centralized here so every call site, current and future,
 * surfaces a failure toast without remembering to attach a catch.
 */
const WRITE_FAILURES: Partial<Record<StreamerCommand['type'], string>> = {
  queueSavePreset: "Couldn't save the preset",
  presetRename: "Couldn't rename the preset",
  streamRadio: "Couldn't play the station",
  zoneSavePreset: "Couldn't save the preset",
  recallPreset: "Couldn't recall the preset",
  presetDelete: "Couldn't delete the preset",
  presetMove: "Couldn't reorder the presets",
  queueDelete: "Couldn't remove the track",
  queueMove: "Couldn't reorder the queue"
}

export const tt: TastyTunesApi = {
  ...raw,
  command: async (cmd) => {
    try {
      return await raw.command(cmd)
    } catch (err) {
      // Dynamic import: store.ts imports tt from this module, so the static
      // form would be a cycle; the failure path can afford the lazy load.
      const { useStore } = await import('./store')
      const label = WRITE_FAILURES[cmd.type] ?? 'The streamer refused the command'
      useStore.getState().showToast({ kind: 'error', text: `${label} — streamer error.` })
      // Callers that await (dialogs) still need to know it failed.
      throw err
    }
  }
}
