import type { KnownDevice } from "@shared/model";
import { tt } from "@/api";
import { useStore } from "@/store";

/**
 * Forget a remembered streamer — Bluetooth semantics, one home for the rule
 * (the connect gate and the Device screen both offer it). Deletes the MEMORY,
 * never the device: a forgotten streamer that answers a later sweep reappears
 * as a plain discovery. Three consequences travel together: the book entry
 * goes, `lastHost` clears when it pointed at this device (or the reconnect
 * loop would keep chasing a streamer the user just disowned), and a chase in
 * progress ends. Forgetting is favorites-shaped — pure local state with an
 * exact inverse — so it toasts with Undo and lands on the Cmd-Z stack
 * instead of asking "Sure?".
 */
export function forgetDevice(dev: KnownDevice): void {
  const { settings, connection, saveSettings, pushUndo, runUndo, showToast } = useStore.getState();
  const prevKnown = settings.knownDevices;
  const prevLast = settings.lastHost;
  const clearingLast = prevLast != null && dev.host === prevLast;
  void saveSettings({
    knownDevices: prevKnown.filter((d) => d.udn !== dev.udn),
    ...(clearingLast ? { lastHost: null } : {}),
  });
  const chasing =
    (connection.phase === "connecting" ||
      (connection.phase === "disconnected" && connection.reconnecting)) &&
    connection.host === dev.host;
  if (chasing) void tt.disconnect();
  const undoId = pushUndo(`Forget “${dev.friendlyName}”`, () => {
    void useStore.getState().saveSettings({
      knownDevices: prevKnown,
      ...(clearingLast ? { lastHost: prevLast } : {}),
    });
  });
  showToast({
    kind: "success",
    text: `Forgot “${dev.friendlyName}”`,
    action: { label: "Undo", undo: () => runUndo(undoId) },
  });
}
