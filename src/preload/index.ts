import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC,
  type AppSettings,
  type PushMessage,
  type SleepTimer,
  type StreamerCommand,
  type TastyTunesApi
} from '@shared/ipc'

const api: TastyTunesApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.getSnapshot),
  discover: () => ipcRenderer.invoke(IPC.discover),
  connect: (host: string) => ipcRenderer.invoke(IPC.connect, host),
  disconnect: () => ipcRenderer.invoke(IPC.disconnect),
  command: (cmd: StreamerCommand) => ipcRenderer.invoke(IPC.command, cmd),
  openExternal: (url: string) => ipcRenderer.invoke(IPC.openExternal, url),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  setSettings: (patch: Partial<AppSettings>) => ipcRenderer.invoke(IPC.setSettings, patch),
  fetchArt: (url: string) => ipcRenderer.invoke(IPC.fetchArt, url),
  toggleMini: () => ipcRenderer.invoke(IPC.toggleMini),
  showMain: () => ipcRenderer.invoke(IPC.showMain),
  setSleep: (sleep: SleepTimer | null) => ipcRenderer.invoke(IPC.setSleep, sleep),
  getRecents: () => ipcRenderer.invoke(IPC.getRecents),
  clearRecents: () => ipcRenderer.invoke(IPC.clearRecents),
  onPush: (cb: (msg: PushMessage) => void) => {
    const listener = (_e: IpcRendererEvent, msg: PushMessage): void => cb(msg)
    ipcRenderer.on(IPC.push, listener)
    return () => {
      ipcRenderer.removeListener(IPC.push, listener)
    }
  }
}

contextBridge.exposeInMainWorld('tastytunes', api)
