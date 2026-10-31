import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink, Loader2 } from "lucide-react";
import { tt } from "@/api";
import { ModalShell } from "@/components/chrome/Overlay";
import { ConfirmActions, useConfirmPopover } from "@/components/chrome/Confirm";
import { HeaderChip } from "@/components/chrome/Chrome";
import { cx } from "@/lib/format";

/**
 * A KEY OR TOKEN THE APP KEEPS (0.13.0 rounds 10 and 11, the secrets store; his look at the first
 * cut, 2026-10-25: "entering a token feels awkward and not elegant ... the user needs to know more
 * clearly what the flow is after entering a token (success, failure, etc) vs. that "Get" button
 * which is confusing"). The Settings row says only whether one is saved and how it ends, with Add,
 * Change and Remove (asked first); adding opens a small dialog that walks it: where one is got,
 * where it is pasted, then Check and save, the service asked before it is kept and its answer said
 * in the dialog (works, refused with the field still there to fix, or unreachable and saved). One
 * flow for the fanart.tv key and the ListenBrainz token. The value is never shown or filled back.
 */
export interface SecretKeySpec {
  /** The secret's name, on the row for the suite (data-secret). */
  id: string;
  /** "fanart.tv key", "ListenBrainz token". */
  title: string;
  /** "key", "token": the button's word. */
  noun: string;
  /** What it does for the reader, the dialog's first line. */
  what: string;
  /** Where one is got, step 1's sentence, and its button. */
  getStep: string;
  getLabel: string;
  getUrl: string;
  placeholder: string;
  /** Ask the service, keeping the value if it takes it (or cannot be asked): its verdict, said. */
  check(value: string): Promise<{ verdict: "works" | "refused" | "unreachable"; said: string }>;
  /** Forget it. */
  remove(): Promise<void>;
  /** The question Remove asks. */
  removeQuestion: string;
}

export function SecretKeyRow({
  spec,
  saved,
  ends,
  onChanged,
}: {
  spec: SecretKeySpec;
  saved: boolean;
  ends: string | null;
  /** Told after a save or a removal, so the row reads the store again. */
  onChanged(): void;
}): React.JSX.Element {
  const [adding, setAdding] = useState(false);
  const confirm = useConfirmPopover();
  const chip = "shrink-0 text-[12.5px] px-3 py-1.5 motion-safe:active:scale-90";
  return (
    <div
      className="flex items-center gap-2"
      data-secret={spec.id}
      data-secret-state={saved ? "saved" : "none"}
    >
      {saved ? (
        <>
          <span className="flex items-center gap-1.5 text-[12.5px] text-dim whitespace-nowrap">
            <Check size={13} className="text-gold" />
            Saved, ending in <span className="font-mono text-ink">{ends}</span>
          </span>
          <HeaderChip onClick={() => setAdding(true)} className={chip}>
            Change…
          </HeaderChip>
          <HeaderChip
            onClick={(e) =>
              confirm.ask(e, {
                question: spec.removeQuestion,
                verb: "Remove",
                onConfirm: () => void spec.remove().then(onChanged),
              })
            }
            className={chip}
          >
            Remove
          </HeaderChip>
          {confirm.popover}
        </>
      ) : (
        <>
          <span className="text-[12.5px] text-faint whitespace-nowrap">Not set</span>
          <HeaderChip onClick={() => setAdding(true)} className={chip}>
            Add {spec.noun}…
          </HeaderChip>
        </>
      )}
      <SecretKeyDialog
        spec={spec}
        open={adding}
        changing={saved}
        onClose={() => setAdding(false)}
        onSaved={onChanged}
      />
    </div>
  );
}

type Stage =
  | { kind: "entry" }
  | { kind: "checking" }
  | { kind: "refused"; said: string }
  | { kind: "done"; verdict: "works" | "unreachable"; said: string };

function SecretKeyDialog({
  spec,
  open,
  changing,
  onClose,
  onSaved,
}: {
  spec: SecretKeySpec;
  open: boolean;
  changing: boolean;
  onClose(): void;
  onSaved(): void;
}): React.JSX.Element {
  const [value, setValue] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "entry" });
  const input = useRef<HTMLInputElement | null>(null);
  // every opening starts clean: nothing pasted before is kept in the window
  useEffect(() => {
    if (!open) return;
    setValue("");
    setStage({ kind: "entry" });
    const t = setTimeout(() => input.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [open]);
  const close = (): void => {
    setValue("");
    onClose();
  };
  const submit = (): void => {
    const v = value.trim();
    if (!v || stage.kind === "checking") return;
    setStage({ kind: "checking" });
    void spec
      .check(v)
      .then(({ verdict, said }) => {
        if (verdict === "refused") return setStage({ kind: "refused", said });
        setValue("");
        setStage({ kind: "done", verdict, said });
        onSaved();
      })
      .catch(() => setStage({ kind: "refused", said: `Couldn't save the ${spec.noun}.` }));
  };
  const heading = `${changing ? "Change" : "Add"} your ${spec.title}`;
  return (
    <ModalShell
      open={open}
      onClose={close}
      escapeCloses
      label={heading}
      className="w-[27rem] max-w-[calc(100vw-3rem)] p-5"
    >
      <div data-secret-dialog={spec.id} className="space-y-4">
        <div className="text-[14px] font-medium text-ink">{heading}</div>
        {stage.kind === "done" ? (
          <>
            <div className="flex items-start gap-3" data-secret-result={stage.verdict}>
              <span
                className={cx(
                  "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full",
                  stage.verdict === "works" ? "bg-golddim text-gold" : "bg-veil text-dim",
                )}
              >
                <Check size={15} />
              </span>
              <p className="text-[13px] leading-snug text-ink">{stage.said}</p>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                autoFocus
                onClick={close}
                className="px-3 py-1 rounded-lg text-[12.5px] bg-gold text-bg font-medium hover:brightness-110"
              >
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-[12.5px] leading-snug text-dim">{spec.what}</p>
            <ol className="space-y-3">
              <li className="flex gap-3">
                <StepNumber n={1} />
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="text-[12.5px] leading-snug text-ink">{spec.getStep}</p>
                  {/* no hover transition inside the modal (ModalShell's note: it crawls over the blur) */}
                  <button
                    type="button"
                    data-secret-get
                    onClick={() => void tt.openExternal(spec.getUrl)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] ring-1 ring-edge bg-panel/70 text-dim hover:text-ink hover:ring-edge2 hover:bg-raised/70"
                  >
                    {spec.getLabel}
                    <ExternalLink size={12} />
                  </button>
                </div>
              </li>
              <li className="flex gap-3">
                <StepNumber n={2} />
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="text-[12.5px] leading-snug text-ink">Paste it here.</p>
                  <input
                    ref={input}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={value}
                    placeholder={spec.placeholder}
                    aria-label={spec.title}
                    disabled={stage.kind === "checking"}
                    onChange={(e) => {
                      setValue(e.target.value);
                      if (stage.kind === "refused") setStage({ kind: "entry" });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submit();
                    }}
                    className="w-full bg-bg rounded-lg ring-1 ring-edge px-3 py-1.5 text-[12.5px] font-mono outline-none focus:ring-edge2 placeholder:text-faint disabled:opacity-60"
                  />
                </div>
              </li>
            </ol>
            <div aria-live="polite" className="min-h-[1.25rem]">
              {stage.kind === "checking" && (
                <p className="flex items-center gap-2 text-[12px] text-dim">
                  <Loader2 size={13} className="motion-safe:animate-spin" />
                  Checking…
                </p>
              )}
              {stage.kind === "refused" && (
                <p data-secret-result="refused" className="text-[12px] leading-snug text-alert">
                  {stage.said}
                </p>
              )}
            </div>
            <ConfirmActions
              modal
              tone="gold"
              verb="Check and save"
              busy={!value.trim() || stage.kind === "checking"}
              onCancel={close}
              onConfirm={submit}
            />
          </>
        )}
      </div>
    </ModalShell>
  );
}

function StepNumber({ n }: { n: number }): React.JSX.Element {
  return (
    <span className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full ring-1 ring-edge2 font-mono text-[10.5px] text-dim">
      {n}
    </span>
  );
}
