import { useEffect } from "react";
import { tt } from "@/api";
import { useStore } from "@/store";
import { ModalShell } from "@/components/chrome/Overlay";
import { ConfirmActions } from "@/components/chrome/Confirm";

/**
 * THE ASK FROM ANOTHER SCREEN (0.17.0, controls on the other screens): a screen showing Display on
 * other screens that hasn't been allowed asks at its first tap, and the app asks here, one screen
 * at a time, naming it by its device and browser. "Not now" keeps that screen from asking again
 * for a while (main/servers/displayScreens); Settings › Integrations can still allow it. A centred
 * dialog: the ask comes from another room, with no control here to anchor to. Mounted once, in
 * the main window.
 */
export function DisplayAskPrompt(): React.JSX.Element | null {
  const asking = useStore((s) => s.displayScreens?.asking ?? null);
  useEffect(() => {
    void tt.getDisplayScreens().then((displayScreens) => useStore.setState({ displayScreens }));
  }, []);
  const answer = (allowed: boolean): void => {
    if (!asking) return;
    void tt
      .displayScreenAllow(asking.id, allowed)
      .then((displayScreens) => useStore.setState({ displayScreens }));
  };
  return (
    <ModalShell
      open={asking != null}
      onClose={() => answer(false)}
      escapeCloses
      label="Allow this screen to control playback"
      className="w-80 p-4"
    >
      {asking && (
        <div data-display-ask={asking.id}>
          <div className="text-[13px] text-ink leading-snug">
            Allow this screen to control playback?
          </div>
          <div className="mt-1 text-[12px] text-dim leading-snug">
            {asking.name}, showing Display on other screens.
          </div>
          <ConfirmActions
            modal
            tone="accent"
            cancel="Not now"
            verb="Allow"
            onCancel={() => answer(false)}
            onConfirm={() => answer(true)}
          />
        </div>
      )}
    </ModalShell>
  );
}
