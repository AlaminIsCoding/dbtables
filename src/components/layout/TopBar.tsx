import { Button } from "../ui/button";
import { cn } from "../ui/cn";

export interface TopBarProps {
  /** Concrete theme currently applied. */
  theme: "light" | "dark";
  /** Switches between light and dark. */
  onToggleTheme: () => void;
  className?: string;
}

/** Compact application header: product name and global workspace actions. */
export function TopBar({ theme, onToggleTheme, className }: TopBarProps) {
  const nextTheme = theme === "dark" ? "light" : "dark";

  return (
    <header
      className={cn(
        "flex h-9 shrink-0 items-center justify-between border-b border-border bg-card px-3",
        className,
      )}
    >
      <div className="flex items-baseline gap-2">
        <h1 className="text-sm font-semibold tracking-tight">dbtables</h1>
        <span className="text-[11px] text-muted-foreground">
          Workspace prototype
        </span>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">
          No active connection
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleTheme}
          aria-label={`Switch to ${nextTheme} theme`}
        >
          {nextTheme === "dark" ? "Dark" : "Light"}
        </Button>
      </div>
    </header>
  );
}
