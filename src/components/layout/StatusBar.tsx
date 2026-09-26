import { useBackendStatus } from "../../app/useBackendStatus";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";

export interface StatusBarProps {
  className?: string;
}

/** Compact status bar carrying the workspace state and backend health check. */
export function StatusBar({ className }: StatusBarProps) {
  const { state, check } = useBackendStatus();

  return (
    <footer
      className={cn(
        "flex h-6 shrink-0 items-center justify-between gap-2 border-t border-border bg-sidebar px-2 text-[11px] text-muted-foreground",
        className,
      )}
    >
      <span>Prototype · mock data only</span>

      <div className="flex items-center gap-2">
        <span
          role="status"
          aria-live="polite"
          className="truncate"
        >
          {state.status === "idle" && "Backend not checked."}
          {state.status === "pending" && "Waiting for the backend…"}
          {state.status === "success" &&
            `${state.response.app}: ${state.response.message}`}
          {state.status === "error" && (
            <span role="alert" className="text-destructive">
              Backend request failed: {state.message}
            </span>
          )}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-2 text-[11px]"
          onClick={() => {
            void check();
          }}
        >
          Check backend
        </Button>
      </div>
    </footer>
  );
}
