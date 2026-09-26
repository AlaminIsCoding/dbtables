import {
  ConnectionManager,
  useConnectionManager,
} from "../../features/connections";
import type { ObjectRef } from "../../domain";
import { ExplorerPanel, toExplorerTarget } from "../../features/explorer";
import { useTableDataSession } from "../../features/table-data";
import { cn } from "../ui/cn";

export interface SidebarProps {
  className?: string;
}

/**
 * Explorer/connections sidebar for the desktop workspace.
 *
 * The sidebar owns the single active connection and shares it with both the
 * connection manager and the explorer, so switching connections scopes the
 * explorer to the new target and never leaves stale objects visible. Selecting
 * a table's "Browse data" action opens the read-only browser in the workspace.
 */
export function Sidebar({ className }: SidebarProps) {
  const connections = useConnectionManager();
  const tableData = useTableDataSession();
  const target = toExplorerTarget(connections.active);

  const onBrowseTable =
    target.status === "connected"
      ? (object: ObjectRef) => tableData.open(target.connectionId, object)
      : undefined;

  return (
    <aside
      aria-label="Workspace navigation"
      className={cn(
        "flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
        className,
      )}
    >
      <ConnectionManager controller={connections} />
      <ExplorerPanel target={target} onBrowseTable={onBrowseTable} />
    </aside>
  );
}
