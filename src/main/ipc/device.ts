import { IPC } from "@shared/ipc";
import type { StreamerCommand } from "@shared/ipc";
import type { SleepTimer } from "@shared/model";
import { dismissMissedSchedule, runMissedSchedule } from "../app/scheduler";
import { deviceManager } from "../app/runtime";
import { demoHost, startDemoStreamer, stopDemoStreamer } from "../servers/demoStreamer";
import { handle } from "../app/guard";

/** Connection, the demo, commands, the sleep timer and missed schedules. (Split out of index.ts's registerIpc in the 0.11.0 sweep.) */
export function registerDeviceIpc(): void {
  handle(IPC.getSnapshot, () => deviceManager.snapshot());
  handle(IPC.discover, () => deviceManager.discover());
  handle(IPC.connect, (_e, host: string) => {
    // Leaving the demo for a real device shuts the demo server down.
    if (demoHost() && host !== demoHost()) stopDemoStreamer();
    deviceManager.connect(host);
  });
  handle(IPC.disconnect, () => {
    deviceManager.disconnect();
    stopDemoStreamer();
  });
  handle(IPC.demoStart, async () => {
    const host = await startDemoStreamer();
    // remember:false — the ephemeral demo port must not be next launch's
    // reconnect target (a first run also stays "never connected").
    deviceManager.connect(host, { remember: false, demo: true });
  });
  handle(IPC.command, (_e, cmd: StreamerCommand) => deviceManager.command(cmd));
  handle(IPC.setSleep, (_e, sleep: SleepTimer | null) => deviceManager.setSleep(sleep));
  handle(IPC.scheduleRunMissed, () => runMissedSchedule(deviceManager));
  handle(IPC.scheduleDismissMissed, () => dismissMissedSchedule(deviceManager));
}
