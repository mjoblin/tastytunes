import { Component, type ReactNode } from "react";
import { CircleAlert, RotateCw } from "lucide-react";
import { tt } from "@/api";
import { useStore } from "@/store";
import { HeaderChip } from "@/components/chrome/Chrome";
import { EmptyState } from "@/components/chrome/EmptyState";

/**
 * ONE SURFACE'S FAILURE STAYS IN THAT SURFACE (0.12.0-rc.2, the 0.11 re-score's crash
 * resilience). A render error used to unmount the whole window to a blank page. Each surface
 * now sits in a boundary of its own: a screen, the navigation, the playback bar, display mode,
 * each overlay, and each window's root (the last resort). A failed surface says so where it
 * was, with Try again (a fresh render of the same surface) and Reload (the window), the error
 * goes to the diagnostics log, and everything around it keeps working. `resetKey` re-arms the
 * boundary when what it shows changes (the main window's screen, an overlay's target), so
 * leaving a broken screen and coming back tries it again. A renderer process that dies outright
 * is main's to bring back (app/crashReload).
 *
 *   screen  the main window's screen area: the empty-state face, both buttons
 *   panel   a small window's root (the mini player, the menu bar panel): the compact face
 *   strip   a band (the navigation, the playback bar): one line and Try again
 *   quiet   an overlay: nothing drawn, an error toast, and the next open tries again
 */
type Shape = "screen" | "panel" | "strip" | "quiet";

interface Props {
  /** The surface's name in the log and the face ("this screen", "the playback bar"). */
  surface: string;
  shape: Shape;
  resetKey?: unknown;
  children: ReactNode;
}

interface State {
  failed: boolean;
  key: unknown;
}

export class SurfaceBoundary extends Component<Props, State> {
  state: State = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null;
  }

  componentDidCatch(error: Error): void {
    void tt
      .reportRenderError(this.props.surface, `${error.name}: ${error.message}`)
      .catch(() => {});
    if (this.props.shape === "quiet") {
      useStore.getState().showToast({ kind: "error", text: "Couldn't open that window." });
    }
  }

  private retry = (): void => this.setState({ failed: false });

  render(): ReactNode {
    const { failed } = this.state;
    const { shape, surface, children } = this.props;
    if (!failed) return children;
    if (shape === "quiet") return null;
    if (shape === "strip") {
      return (
        <div
          role="alert"
          data-surface-error={surface}
          className="h-full min-h-10 flex items-center justify-center gap-3 px-4 text-[12.5px] text-dim"
        >
          <CircleAlert size={14} className="text-alert shrink-0" />
          <span className="truncate">Couldn&apos;t show {surface}</span>
          <HeaderChip onClick={this.retry} className="shrink-0 text-[12px] px-2.5 py-1">
            Try again
          </HeaderChip>
        </div>
      );
    }
    return (
      <div role="alert" data-surface-error={surface} className="h-full flex">
        <EmptyState
          icon={CircleAlert}
          title={`Couldn't show ${surface}`}
          caption={shape === "screen" ? "The rest of TastyTunes is still working." : undefined}
          compact={shape === "panel"}
        >
          <div className="flex items-center gap-2">
            <HeaderChip onClick={this.retry} className="text-[12.5px] px-3 py-1.5">
              Try again
            </HeaderChip>
            <HeaderChip
              onClick={() => window.location.reload()}
              className="flex items-center gap-1.5 text-[12.5px] px-3 py-1.5"
            >
              <RotateCw size={13} />
              Reload
            </HeaderChip>
          </div>
        </EmptyState>
      </div>
    );
  }
}
