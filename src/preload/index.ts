import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { INVOKE_METHODS, IPC, type PushMessage, type TastyTunesApi } from "@shared/ipc";

/**
 * THE BRIDGE, GENERATED FROM THE CHANNEL TABLE (0.11.0 sweep; it was 70 hand-written
 * lines, one per method, each a chance to pass the wrong channel or drop an argument).
 * Every invoked method forwards its arguments to its own channel (@shared/ipc
 * INVOKE_METHODS, checked against TastyTunesApi at compile time); the push stream and the
 * one-way display-mode report are the two written out.
 */
const invokers = Object.fromEntries(
  INVOKE_METHODS.map((m) => [m, (...args: unknown[]) => ipcRenderer.invoke(IPC[m], ...args)]),
);

// one cast, at the seam: each invoker carries its method's arguments to the handler main
// registered under the same name, which is typed by the same contract (app/guard handle)
const api = {
  ...invokers,
  reportDisplayMode: (on: boolean) => ipcRenderer.send(IPC.displayModeReport, on),
  onPush: (cb: (msg: PushMessage) => void) => {
    const listener = (_e: IpcRendererEvent, msg: PushMessage): void => cb(msg);
    ipcRenderer.on(IPC.push, listener);
    return () => {
      ipcRenderer.removeListener(IPC.push, listener);
    };
  },
} as unknown as TastyTunesApi;

contextBridge.exposeInMainWorld("tastytunes", api);
