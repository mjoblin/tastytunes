import { useEffect, useState } from "react";
import type { ExportFolderStatus } from "@shared/ipc";
import { tt } from "@/api";
import { HeaderChip } from "@/components/chrome/Chrome";

/**
 * WHERE EXPORTS GO (0.17.0, main/app/exportsFolder): the folder the Exports tools write into, with
 * Show and Change, under the Exports group's switch. The folder is set only by the dialog Change
 * opens (and the one switching the group on opens first).
 */
export function ExportFolderRow({ folder }: { folder: string | null }): React.JSX.Element {
  const [status, setStatus] = useState<ExportFolderStatus | null>(null);
  useEffect(() => {
    let live = true;
    void tt.getExportFolder().then((s) => {
      if (live) setStatus(s);
    });
    return () => {
      live = false;
    };
  }, [folder]);
  const chip = "shrink-0 text-[12px] px-2.5 py-1 motion-safe:active:scale-90";
  return (
    <div data-export-folder className="mt-2 flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[12px] text-dim">Export folder</div>
        <div
          className="font-mono text-[11px] text-faint truncate"
          title={status?.folder ?? undefined}
        >
          {status?.folder ?? "Not chosen yet"}
          {status?.folder && !status.usable && " (not found)"}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        {status?.folder && status.usable && (
          <HeaderChip onClick={() => void tt.revealExportFolder()} className={chip}>
            Show
          </HeaderChip>
        )}
        <HeaderChip onClick={() => void tt.chooseExportFolder().then(setStatus)} className={chip}>
          {status?.folder ? "Change" : "Choose"}
        </HeaderChip>
      </div>
    </div>
  );
}
