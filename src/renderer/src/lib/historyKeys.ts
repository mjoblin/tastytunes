// THE HISTORY KEYS ON A QUERY JUST ARRIVED IN ITS BOX: while the box's whole query is selected (an
// arrival selects it, ⌘F's recall or a pivot), ⌘← (and ⌘→ where a box offers it) NAVIGATE, the
// reflex for leaving; once the selection collapses (typing, clicking) the arrows are ordinary
// text-editing keys again. ⌥ stands in for ⌘ on Windows and Linux. The blurred-box case is
// useShortcuts'. One home for every search box that has the rule.
import { useStore } from "@/store";

export interface HistoryKeyRule {
  /** ⌘→ goes forward too (the Library's box), not only ⌘← back. */
  forward: boolean;
  /** ⌘← navigates only with somewhere to go back to (the Search box); otherwise it edits text. */
  needsBackStack: boolean;
}

/** Handles the key when it is a history key on an arrived query, and says whether it did. */
export function historyKeyOnArrival(
  e: React.KeyboardEvent<HTMLInputElement>,
  rule: HistoryKeyRule,
): boolean {
  if (!((e.metaKey || e.altKey) && !e.ctrlKey)) return false;
  const back = e.key === "ArrowLeft";
  if (!back && !(rule.forward && e.key === "ArrowRight")) return false;
  const el = e.currentTarget;
  if (!(el.selectionStart === 0 && el.selectionEnd === el.value.length && el.value.length > 0))
    return false;
  const s = useStore.getState();
  if (back && rule.needsBackStack && s.navBackStack.length === 0) return false;
  e.preventDefault();
  if (back) s.goBack();
  else s.goForward();
  return true;
}
