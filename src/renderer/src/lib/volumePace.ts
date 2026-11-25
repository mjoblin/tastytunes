// A HELD RAISE IS PACED (0.16.0, the volume's guard). A held key repeats about 30 times a second,
// faster than anyone hears the volume climb, so a held raise steps at most every VOLUME_REPEAT_MS.
// A lowering is never paced: when it's too loud, down has to be quick. One pace for the volume
// shortcut (useShortcuts) and every guarded slider (Slider's raiseBy), so the two can't drift apart.

export const VOLUME_REPEAT_MS = 200;

/** Whether this key press may move the volume: a first press always, a raise's repeat once the
 *  last raise is VOLUME_REPEAT_MS old, a lowering always. Each pace keeps its own last raise. */
export type RaisePace = (repeat: boolean, raising: boolean, now?: number) => boolean;

export function raisePace(every = VOLUME_REPEAT_MS): RaisePace {
  let last = -Infinity;
  return (repeat, raising, now = Date.now()) => {
    if (!raising) return true;
    if (repeat && now - last < every) return false;
    last = now;
    return true;
  };
}
