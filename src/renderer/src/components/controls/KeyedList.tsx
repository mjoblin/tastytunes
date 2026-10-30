import { useRef } from "react";
import {
  gridColumnsOf,
  ListKeysContext,
  useListKeys,
  type ListItemAttrs,
  type ListKeysOptions,
} from "@/hooks/useListKeys";

/**
 * A KEYED LIST AS AN ELEMENT (0.14.0, hooks/useListKeys): for a screen that draws a list more
 * than once in one render (an artist folder's albums and its folders), where a hook per list
 * can't be called. The element is the list's one Tab stop; its children get each item's
 * attributes. A grid (`grid`) counts its own columns at the key press, as auto-fill lays them.
 */
export function KeyedList({
  label,
  grid = false,
  className,
  style,
  children,
  ...options
}: Omit<ListKeysOptions, "columns"> & {
  label: string;
  /** The element is a CSS grid: the arrows move in all four directions. */
  grid?: boolean;
  className?: string;
  style?: React.CSSProperties;
  children(item: (i: number) => ListItemAttrs): React.ReactNode;
}): React.JSX.Element {
  const el = useRef<HTMLDivElement | null>(null);
  const keys = useListKeys({
    ...options,
    columns: grid ? () => gridColumnsOf(el.current) : undefined,
  });
  return (
    <div
      {...keys.container}
      ref={(node) => {
        el.current = node;
        keys.container.ref(node);
      }}
      aria-label={label}
      className={className}
      style={style}
    >
      <ListKeysContext.Provider value={true}>{children(keys.item)}</ListKeysContext.Provider>
    </div>
  );
}
