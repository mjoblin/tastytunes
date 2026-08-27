import { cx } from "@/lib/format";

/**
 * The app's switch, extracted from Settings' Toggle so inline spots (the
 * sleep popover, schedule cards) speak the same control language — "sm" is
 * the compact size those tight rows need. Disabled keeps it visible: a rule
 * worth knowing (an end-of-track timer can't fade) reads better greyed than
 * hidden.
 */
export function Switch({
  checked,
  onChange,
  size = "md",
  disabled = false,
}: {
  checked: boolean;
  onChange(next: boolean): void;
  size?: "md" | "sm";
  disabled?: boolean;
}): React.JSX.Element {
  const sm = size === "sm";
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault();
        if (!disabled) onChange(!checked);
      }}
      className={cx(
        "relative shrink-0 rounded-full transition-colors",
        sm ? "h-4 w-7" : "h-5 w-9",
        checked ? "bg-gold" : "bg-veil2 ring-1 ring-edge",
        disabled && "opacity-40 pointer-events-none",
      )}
    >
      <span
        className={cx(
          "absolute top-0.5 rounded-full bg-bg transition-all",
          sm ? "h-3 w-3" : "h-4 w-4",
          checked ? (sm ? "left-[14px]" : "left-[18px]") : "left-0.5",
        )}
      />
    </button>
  );
}
