import { cn } from "../../components/ui/cn";
import { ExplorerTree } from "./ExplorerTree";
import { ObjectDetail } from "./ObjectDetail";
import type { ExplorerTarget } from "./target";
import { useExplorer } from "./useExplorer";

export interface ExplorerPanelProps {
  /** Active connection the explorer is scoped to. */
  target: ExplorerTarget;
  className?: string;
}

/**
 * Explorer panel: the scope/object tree above the selected object's metadata.
 *
 * State is owned by {@link useExplorer}, which discards results for a previous
 * connection when the target changes so stale metadata is never shown under a
 * new connection.
 */
export function ExplorerPanel({ target, className }: ExplorerPanelProps) {
  const controller = useExplorer(target);

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <ExplorerTree controller={controller} />
      <ObjectDetail
        object={controller.selected}
        state={controller.detail}
        className="max-h-72 shrink-0 overflow-auto"
      />
    </div>
  );
}
