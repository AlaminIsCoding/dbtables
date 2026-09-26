import { cn } from "../ui/cn";
import { QueryTabs } from "./QueryTabs";

export interface WorkspaceProps {
  className?: string;
}

/** Main workspace: query tabs above an editor/results split. */
export function Workspace({ className }: WorkspaceProps) {
  return (
    <main
      aria-label="Workspace"
      className={cn("flex min-w-0 flex-1 flex-col bg-background", className)}
    >
      <QueryTabs />
    </main>
  );
}
