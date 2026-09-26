import { AlertTriangleIcon } from "lucide-react";

import { SqlCode } from "@/components/sql-code";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { QueryError } from "@/domain";
import { cn } from "@/lib/utils";

/** Compact destructive alert for a normalized backend error. */
export function ErrorBanner({
  error,
  title = "Operation failed",
  className,
}: {
  error: QueryError;
  title?: string;
  className?: string;
}) {
  return (
    <Alert variant="destructive" className={cn("rounded-md px-2 py-1.5", className)}>
      <AlertTriangleIcon />
      <AlertTitle className="text-xs">{title}</AlertTitle>
      <AlertDescription className="text-[11px]">
        <span>{error.message}</span>
        {error.engineDetail ? (
          <span className="mt-0.5 block font-mono text-[10px] break-words">
            {error.engineDetail}
          </span>
        ) : null}
        <span className="mt-0.5 block text-[10px] tracking-wide uppercase">
          {error.category}
        </span>
      </AlertDescription>
    </Alert>
  );
}

/** Scrollable, syntax-highlighted SQL preview body. */
export function SqlPreview({
  statements,
  emptyLabel,
  className,
}: {
  statements: readonly string[];
  emptyLabel: string;
  className?: string;
}) {
  return (
    <ScrollArea className={cn("min-h-0 flex-1", className)}>
      {statements.length === 0 ? (
        <p className="p-2 text-[11px] text-muted-foreground">{emptyLabel}</p>
      ) : (
        <SqlCode sql={statements.join("\n\n")} />
      )}
    </ScrollArea>
  );
}
