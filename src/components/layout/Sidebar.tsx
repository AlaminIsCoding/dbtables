import { ConnectionManager } from "../../features/connections";
import { cn } from "../ui/cn";

export interface SidebarProps {
  className?: string;
}

/** Explorer/connections sidebar for the desktop workspace. */
export function Sidebar({ className }: SidebarProps) {
  return (
    <aside
      aria-label="Workspace navigation"
      className={cn(
        "flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
        className,
      )}
    >
      <ConnectionManager />

      <h2 className="flex h-8 items-center border-t border-sidebar-border px-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Explorer
      </h2>
      <div className="flex-1 overflow-auto px-3 py-2">
        <p className="text-xs text-muted-foreground">
          Connect to a database to browse schemas, tables, and views.
        </p>
      </div>
    </aside>
  );
}
