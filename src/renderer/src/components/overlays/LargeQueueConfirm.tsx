import { useSyncExternalStore } from "react";
import { ModalShell } from "@/components/chrome/Overlay";
import { ConfirmActions } from "@/components/chrome/Confirm";
import { fmtCount } from "@/lib/format";

/**
 * THE LARGE-QUEUE CONFIRM (2026-09-10). Main refuses a container verb over
 * LARGE_QUEUE_TRACKS until the caller confirms (upnpBrowser's guard, filed
 * after 2,528 tracks queued without a word); the tt wrapper in api.ts catches
 * that refusal for every caller, asks here, and calls again. A centred dialog,
 * not the anchored confirm: the queue verbs fire from menus that have already
 * closed, so there is no control left to anchor to. Mounted once in each
 * renderer that can queue (App, the tray panel). With no host mounted, or an
 * ask already open, the ask declines: a large container never queues unasked.
 */
type Ask = { tracks: number; replaces: boolean; answer(yes: boolean): void };

let pending: Ask | null = null;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function askLargeQueue(tracks: number, replaces: boolean): Promise<boolean> {
  if (listeners.size === 0 || pending) return Promise.resolve(false);
  return new Promise((resolve) => {
    pending = {
      tracks,
      replaces,
      answer: (yes) => {
        pending = null;
        emit();
        resolve(yes);
      },
    };
    emit();
  });
}

export function LargeQueueConfirm(): React.JSX.Element | null {
  const ask = useSyncExternalStore(subscribe, () => pending);
  return (
    <ModalShell
      open={ask != null}
      onClose={() => ask?.answer(false)}
      escapeCloses
      className="w-80 p-4"
    >
      {ask && (
        <div data-large-queue={ask.tracks}>
          <div className="text-[13px] text-ink leading-snug">
            Queue {fmtCount(ask.tracks)} tracks?
          </div>
          {ask.replaces && (
            <div className="mt-1 text-[12px] text-dim leading-snug">
              This replaces the current queue.
            </div>
          )}
          <ConfirmActions
            modal
            verb="Queue them"
            onCancel={() => ask.answer(false)}
            onConfirm={() => ask.answer(true)}
          />
        </div>
      )}
    </ModalShell>
  );
}
