import { useEffect } from "react";

import { Button } from "../../components/ui/button";
import { cn } from "../../components/ui/cn";
import type { CellValue } from "../../domain";
import { formatValueForViewer } from "./valueView";

export interface ValueViewerProps {
  /** Normalized value to inspect. */
  value: CellValue;
  /** Column label shown in the viewer header. */
  columnName: string;
  /** One-based row number shown in the viewer header. */
  rowNumber: number;
  /** Closes the viewer. */
  onClose: () => void;
  className?: string;
}

/**
 * Modal viewer for a single cell value.
 *
 * Unlike the grid, which flattens newlines and elides long/binary values, this
 * shows the full value and pretty-prints JSON-like structured text. It is
 * read-only; editing result cells is out of scope for the query workspace.
 */
export function ValueViewer({
  value,
  columnName,
  rowNumber,
  onClose,
  className,
}: ValueViewerProps) {
  const content = formatValueForViewer(value);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const meta: string[] = [];
  if (content.structured) {
    meta.push("structured");
  }
  if (content.byteLength !== undefined) {
    meta.push(`${content.byteLength} bytes`);
  }
  meta.push(`${content.text.length} characters`);

  return (
    <div
      data-testid="value-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={`Cell value: ${columnName}`}
      className={cn(
        "absolute inset-0 z-10 flex items-center justify-center bg-background/70 p-4",
        className,
      )}
    >
      <div className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-md border border-border bg-background shadow-lg">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-[11px]">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">{columnName}</span>
            <span className="shrink-0 text-muted-foreground">
              Row {rowNumber}
            </span>
          </div>
          <Button
            autoFocus
            size="sm"
            variant="ghost"
            className="h-5 px-1.5 text-[10px]"
            onClick={onClose}
            aria-label="Close value viewer"
          >
            Close
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          <pre
            data-testid="value-viewer-text"
            className="whitespace-pre-wrap break-words font-mono text-xs"
          >
            {content.text}
          </pre>
        </div>

        <div className="shrink-0 border-t border-border px-3 py-1 text-[10px] text-muted-foreground">
          {meta.join(" · ")}
        </div>
      </div>
    </div>
  );
}
