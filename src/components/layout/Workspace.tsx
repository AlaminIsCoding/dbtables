import { TableDataView, useTableDataSession } from "../../features/table-data";
import { cn } from "../ui/cn";
import { QueryTabs } from "./QueryTabs";

export interface WorkspaceProps {
  className?: string;
}

/**
 * Main workspace.
 *
 * Shows the read-only table data browser when the explorer has opened a table,
 * otherwise the query tabs. Only one table is open at a time; closing the browser
 * returns to the SQL workspace.
 */
export function Workspace({ className }: WorkspaceProps) {
  const { target, close } = useTableDataSession();

  return (
    <main
      aria-label="Workspace"
      className={cn("flex min-w-0 flex-1 flex-col bg-background", className)}
    >
      {target ? (
        <TableDataView
          key={`${target.connectionId}\u0000${target.object.database ?? ""}\u0000${
            target.object.schema ?? ""
          }\u0000${target.object.kind}\u0000${target.object.name}`}
          connectionId={target.connectionId}
          object={target.object}
          onClose={close}
        />
      ) : (
        <QueryTabs />
      )}
    </main>
  );
}
