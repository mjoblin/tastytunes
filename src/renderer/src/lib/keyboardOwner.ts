/**
 * WHO HAS THE KEYBOARD (0.12.0, his report: ⌘← moved the app behind the Info window). While a
 * modal is open (any ModalShell: Info, the shortcuts sheet, About, the dialogs), the keys are
 * the modal's: nothing behind it may act on them. Before this, every screen's own key listener
 * had to remember that and none did: the Library's Backspace went up a level behind Info, and
 * the Queue's Delete removed the selected tracks behind it.
 *
 * ModalShell holds the keyboard while it is open. A screen listens through onScreenKey, which
 * stays quiet while a modal holds it (the lint rule window-keydown keeps raw window listeners
 * to the few that own their keys: the app's shortcuts, a popover's or a drag's Escape, the
 * focus-ring modality). The app's shortcuts (useShortcuts) ask modalHasKeyboard and route the
 * keys a modal uses to it.
 */
let held = 0;

/** A modal takes the keyboard; the returned function gives it back (once). */
export function holdKeyboard(): () => void {
  held++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held--;
  };
}

export function modalHasKeyboard(): boolean {
  return held > 0;
}

/** A screen's window key listener, quiet while a modal has the keyboard. */
export function onScreenKey(handler: (e: KeyboardEvent) => void): () => void {
  const listener = (e: KeyboardEvent): void => {
    if (held > 0) return;
    handler(e);
  };
  window.addEventListener("keydown", listener);
  return () => window.removeEventListener("keydown", listener);
}
