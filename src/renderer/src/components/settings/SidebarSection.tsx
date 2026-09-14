import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Eye, EyeOff, Lock } from "lucide-react";
import { useStore, type Screen } from "@/store";
import { cx } from "@/lib/format";
import {
  MOD,
  NAV_SCREENS,
  orderedNavScreens,
  NAV_TOOLS,
  NAV_UNHIDEABLE,
  SETTINGS_SCREEN,
  sanitizeNavHidden,
  sanitizeNavHiddenTools,
  type NavTool,
  type NavToolDef,
  type ScreenDef,
} from "@/lib/screens";
import { OrderHandle } from "@/components/controls/OrderHandle";
import { lockVertical } from "@/lib/dnd";
import { HeaderChip } from "@/components/chrome/Chrome";

// The Sidebar section, split out of SettingsScreen.tsx 2026-09-13 (the Settings split: the screen had held every
// section and control at 2,142 lines); the shared rows and controls live in ./SettingsKit.

export function SidebarSection(): React.JSX.Element {
  const navHidden = useStore((s) => s.settings.navHidden);
  const navHiddenTools = useStore((s) => s.settings.navHiddenTools);
  const navOrder = useStore((s) => s.settings.navOrder);
  const save = useStore((s) => s.saveSettings);
  const hidden = sanitizeNavHidden(navHidden);
  const hiddenSet = new Set(hidden);
  const hiddenTools = sanitizeNavHiddenTools(navHiddenTools);
  const hiddenToolSet = new Set(hiddenTools);
  // The one ordered list; hidden rows keep their slot in it, which is what
  // makes unhiding restore position rather than append.
  const ordered = orderedNavScreens(navOrder);
  const ids = ordered.map((sc) => sc.id);
  // Reset is only worth offering once the order actually differs from the
  // default — an inert button is noise.
  const customized = ids.some((id, i) => id !== NAV_SCREENS[i].id);

  // Pointer AND keyboard: a list you can only reorder by dragging can't be
  // reordered at all without a mouse (the a11y round's rule, applied here from
  // the start rather than retrofitted).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const setHidden = (id: Screen, hide: boolean): void => {
    const next = hide ? [...hidden, id] : hidden.filter((s) => s !== id);
    void save({ navHidden: next });
  };
  const setToolHidden = (id: NavTool, hide: boolean): void => {
    const next = hide ? [...hiddenTools, id] : hiddenTools.filter((t) => t !== id);
    void save({ navHiddenTools: next });
  };
  const onDragEnd = (e: DragEndEvent): void => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = ids.indexOf(String(e.active.id) as Screen);
    const to = ids.indexOf(String(e.over.id) as Screen);
    if (from < 0 || to < 0) return;
    // Store the WHOLE resolved order, not a diff — sanitizeNavOrder is then
    // only ever repairing a stale file, never reconstructing intent.
    void save({ navOrder: arrayMove(ids, from, to) });
  };

  return (
    <section className="space-y-3">
      <div className="microlabel">left nav</div>
      <div className="rounded-xl ring-1 ring-edge bg-panel/70 p-4 pt-3">
        <div className="flex items-start gap-3 pb-2">
          <p className="text-[11.5px] text-faint max-w-md">
            Drag to reorder the left nav, and hide what you don&apos;t use. Hidden screens stay
            reachable by their keyboard shortcut and the command palette; Commands stays on {MOD}K;
            the mini player stays in the palette and the View menu.{" "}
            <span className="text-dim">Each screen keeps its shortcut key wherever it moves.</span>
          </p>
          {customized && (
            <HeaderChip
              onClick={() => void save({ navOrder: [] })}
              data-tip="Back to the default order"
              className="tip-top tip-end shrink-0 text-[12px] px-2.5 py-1 motion-safe:active:scale-90"
            >
              Reset order
            </HeaderChip>
          )}
        </div>
        <div className="space-y-0.5">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              {ordered.map((sc) => (
                <SidebarRow
                  key={sc.id}
                  sc={sc}
                  sortableId={sc.id}
                  locked={NAV_UNHIDEABLE.includes(sc.id)}
                  hidden={hiddenSet.has(sc.id)}
                  onToggle={(hide) => setHidden(sc.id, hide)}
                />
              ))}
            </SortableContext>
          </DndContext>
          {/* Below the line: the pinned bottom cluster. Hideable, but NOT
              reorderable — its slots are fixed, so there is nothing to drag. */}
          <div className="my-1 border-t border-edge/60" />
          {NAV_TOOLS.map((t) => (
            <SidebarRow
              key={t.id}
              sc={t}
              locked={false}
              hidden={hiddenToolSet.has(t.id)}
              onToggle={(hide) => setToolHidden(t.id, hide)}
            />
          ))}
          <SidebarRow sc={SETTINGS_SCREEN} locked hidden={false} />
        </div>
      </div>
    </section>
  );
}

function SidebarRow({
  sc,
  sortableId,
  locked,
  hidden,
  onToggle,
}: {
  sc: ScreenDef | NavToolDef;
  /** Present for the reorderable screen rows; absent for the pinned cluster. */
  sortableId?: Screen;
  locked: boolean;
  hidden: boolean;
  onToggle?: (hide: boolean) => void;
}): React.JSX.Element {
  const body = (
    <SidebarRowBody
      Icon={sc.icon}
      label={sc.label}
      keyBadge={"key" in sc ? sc.key : null}
      locked={locked}
      hidden={hidden}
      onToggle={onToggle}
    />
  );
  if (sortableId) {
    return (
      <SortableSidebarRow id={sortableId} label={sc.label} hidden={hidden}>
        {body}
      </SortableSidebarRow>
    );
  }
  return (
    <div className="group flex items-center gap-3 h-9 px-1.5 rounded-lg">
      {/* the grip column the sortable rows use, held empty so the pinned
          cluster's icons and labels stay on the same vertical lines */}
      <span className="w-[26px] shrink-0" />
      {body}
    </div>
  );
}

/** The draggable shell: OrderHandle in the leading cell, lockVertical on the
 *  transform (a one-axis list — see lib/dnd). */
function SortableSidebarRow({
  id,
  label,
  hidden,
  children,
}: {
  id: Screen;
  label: string;
  hidden: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(lockVertical(transform)), transition }}
      data-nav-order-row={id}
      className={cx(
        "group flex items-center gap-3 h-9 px-1.5 rounded-lg",
        isDragging && "z-10 bg-raised shadow-xl",
      )}
    >
      {/* The grip stays at full strength on a hidden row: you must be able to
          move a row you have hidden, and dimming the one control that says
          "this is draggable" would hide the affordance with the content. */}
      <div className={cx("w-[26px] shrink-0", hidden && "opacity-100")}>
        <OrderHandle label={`Reorder ${label}`} attributes={attributes} listeners={listeners}>
          {/* A nav row shows NOTHING at rest — order is the point, not the slot
              index, and numbering a list of ten screens 1–10 invites reading
              them as ranks. But the child still has to CARRY HEIGHT:
              OrderHandle sizes its box from whatever sits here and lays the
              grip over it with `absolute inset-0`, so an empty child collapses
              the box to zero — which drops the icon half its own height below
              the row AND leaves the button with no hit area (the drag then
              only works because the overflowing icon is itself clickable).
              15px matches the row's leading icon, so the grip lands on the
              same centre line as everything else in the row. */}
          <span className="block h-[15px]" />
        </OrderHandle>
      </div>
      {children}
    </div>
  );
}

function SidebarRowBody({
  Icon,
  label,
  keyBadge,
  locked,
  hidden,
  onToggle,
}: {
  Icon: ScreenDef["icon"];
  label: string;
  /** The screen's shortcut. Shown BECAUSE the row moves: watching the key sit
   *  still while its row travels is the fastest way to learn that keys don't
   *  follow position. */
  keyBadge: string | null;
  locked: boolean;
  hidden: boolean;
  onToggle?: (hide: boolean) => void;
}): React.JSX.Element {
  return (
    <>
      <Icon
        size={15}
        strokeWidth={1.8}
        className={cx("shrink-0 text-dim", hidden && "opacity-45")}
      />
      <span className={cx("flex-1 text-[13px]", hidden && "opacity-45")}>{label}</span>
      {keyBadge && (
        <span className={cx("font-mono text-[9px] text-faint/60 shrink-0", hidden && "opacity-45")}>
          {keyBadge}
        </span>
      )}
      {locked ? (
        <span
          data-tip="Always shown"
          className="tip-top tip-end flex items-center justify-center h-7 w-7 text-faint"
        >
          <Lock size={13} strokeWidth={1.8} />
        </span>
      ) : (
        <button
          onClick={() => onToggle?.(!hidden)}
          data-tip={hidden ? "Show in left nav" : "Hide from left nav"}
          aria-label={hidden ? `Show ${label} in left nav` : `Hide ${label} from left nav`}
          className="tip-top tip-end flex items-center justify-center h-7 w-7 rounded-md text-dim hover:text-ink hover:bg-veil motion-safe:active:scale-90 transition-all"
        >
          {hidden ? <EyeOff size={15} strokeWidth={1.8} /> : <Eye size={15} strokeWidth={1.8} />}
        </button>
      )}
    </>
  );
}
