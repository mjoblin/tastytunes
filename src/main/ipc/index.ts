import { registerAppIpc } from "./app";
import { registerAudioIpc } from "./audio";
import { registerCollectionsIpc } from "./collections";
import { registerDeviceIpc } from "./device";
import { registerListeningIpc } from "./listening";
import { registerLookupsIpc } from "./lookups";
import { registerMediaIpc } from "./media";
import { registerSettingsIpc } from "./settings";

/**
 * Every IPC handler, registered once in whenReady. One module per domain since the 0.11.0
 * sweep (they were one 360-line function in index.ts); each registers through app/guard's
 * handle and listen, which answer the app's own frames only.
 */
export function registerIpc(): void {
  registerDeviceIpc();
  registerSettingsIpc();
  registerAppIpc();
  registerLookupsIpc();
  registerAudioIpc();
  registerCollectionsIpc();
  registerListeningIpc();
  registerMediaIpc();
}
