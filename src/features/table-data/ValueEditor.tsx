import { useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import { cn } from "../../components/ui/cn";
import type { CellValue, ColumnInfo } from "../../domain";
import {
  cellValueToEditText,
  isEditableValue,
  parseEditedCellValue,
} from "./editorValue";

export interface ValueEditorProps {
  /** Current normalized value. */
  value: CellValue;
  /** Column the value belongs to. */
  column: ColumnInfo;
  /** One-based row number shown in the header. */
  rowNumber: number;
  /** Stages the parsed replacement value. */
  onSave: (value: CellValue) => void;
  /** Closes the editor without staging. */
  onClose: () => void;
  className?: string;
}

/**
 * Modal editor for a single cell value.
 *
 * The value is parsed back using its current type, so a numeric column stays
 * numeric. Saving only stages the edit; the actual write happens on apply. A
 * dedicated "NULL" action is offered because an empty string and SQL `NULL` are
 * different values.
 */
export function ValueEditor({
  value,
  column,
  rowNumber,
  onSave,
  onClose,
  className,
}: ValueEditorProps) {
  const [text, setText] = useState(() => cellValueToEditText(value));
  const [error, setError] = useState<string | null>(null);
  const editable = isEditableValue(value);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleSave = () => {
    const parsed = parseEditedCellValue(text, value);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    onSave(parsed.value);
    onClose();
  };

  return (
    <div
      data-testid="value-editor"
      role="dialog"
      aria-modal="true"
      aria-label={`Edit value: ${column.name}`}
      className={cn(
        "absolute inset-0 z-10 flex items-center justify-center bg-background/70 p-4",
        className,
      )}
    >
      <div className="flex w-full max-w-lg flex-col overflow-hidden rounded-md border border-border bg-background shadow-lg">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-[11px]">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">{column.name}</span>
            <span className="shrink-0 text-muted-foreground">Row {rowNumber}</span>
            <span className="shrink-0 rounded-sm border border-border px-1 text-[9px] uppercase tracking-wide text-muted-foreground">
              {value.type}
            </span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1.5 text-[10px]"
            onClick={onClose}
            aria-label="Close value editor"
          >
            Close
          </Button>
        </div>

        <div className="flex flex-col gap-2 p-3">
          {editable ? (
            <textarea
              aria-label="Cell value"
              value={text}
              autoFocus
              spellCheck={false}
              onChange={(event) => {
                setText(event.target.value);
                setError(null);
              }}
              className="h-32 w-full resize-none rounded-sm border border-input bg-background p-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              Binary values cannot be edited in this view.
            </p>
          )}
          {error ? (
            <p role="alert" className="text-[11px] text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-1 border-t border-border px-3 py-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px]"
            onClick={() => {
              onSave({ type: "null" });
              onClose();
            }}
            disabled={!editable}
          >
            Set NULL
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[10px]"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-6 px-2 text-[10px]"
            onClick={handleSave}
            disabled={!editable}
          >
            Stage edit
          </Button>
        </div>
      </div>
    </div>
  );
}
