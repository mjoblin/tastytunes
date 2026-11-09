// THE HISTORY KEYS ON A QUERY JUST ARRIVED IN ITS BOX: while the box's whole query is selected (an
// arrival selects it, ⌘F's recall or a pivot), ⌘← and ⌘→ navigate back and forward, each only when
// there is somewhere to go, the reflex for leaving; otherwise, and once the selection collapses
// (typing, clicking), the arrows are ordinary text-editing keys. ⌥ stands in for ⌘ on Windows and
// Linux. The blurred-box case is useShortcuts'. One rule for every search box (0.16.0: the Search
// box had taken ⌘← only, the Library's both keys whether or not there was anywhere to go).
import { useStore } from "@/store";

/** Handles the key when it is a history key on an arrived query with somewhere to go, and says
 *  whether it did. */
export function historyKeyOnArrival(e: React.KeyboardEvent<HTMLInputElement>): boolean {
  if (!((e.metaKey || e.altKey) && !e.ctrlKey)) return false;
  const back = e.key === "ArrowLeft";
  if (!back && e.key !== "ArrowRight") return false;
  const el = e.currentTarget;
  if (!(el.selectionStart === 0 && el.selectionEnd === el.value.length && el.value.length > 0))
    return false;
  const s = useStore.getState();
  if ((back ? s.navBackStack : s.navForwardStack).length === 0) return false;
  e.preventDefault();
  if (back) s.goBack();
  else s.goForward();
  return true;
}
