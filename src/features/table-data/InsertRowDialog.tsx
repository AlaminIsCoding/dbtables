import { useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import { cn } from "../../components/ui/cn";
import type { ColumnInfo } from "../../domain";
import type { RowKey } from "../../services/tableData";
import { parseColumnText } from "./editorValue";

export interface InsertRowDialogProps {
  /** Columns the new row may set, in table order. */
  columns: ColumnInfo[];
  /** Stages the insert; only called with at least one value. */
  onStage: (values: RowKey[]) => void;
  /** Closes the dialog without staging. */
  onClose: () => void;
  className?: string;
}

interface FieldState {
  text: string;
  isNull: boolean;
}

function inputClass(): string {
  return "h-6 w-full min-w-0 rounded-sm border border-input bg-background px-1 font-mono text-[11px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50";
}

/**
 * Builds a new-row insert by typing a value per column.
 *
 * Leaving a nullable column blank omits it, so the engine can apply column
 * defaults instead of forcing `NULL`. A required column must be filled, and a
 * non-nullable column cannot be explicitly set to `NULL`. Values are parsed
 * with the column's declared type and only staged here; the row is written on
 * apply.
 */
export function InsertRowDialog({
  columns,
  onStage,
  onClose,
  className,
}: InsertRowDialogProps) {
  const [fields, setFields] = useState<Record<string, FieldState>>(() => {
    const initial: Record<string, FieldState> = {};
    for (const column of columns) {
      initial[column.name] = { text: "", isNull: false };
    }
    return initial;
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const updateField = (name: string, patch: Partial<FieldState>) => {
    setFields((current) => ({
      ...current,
      [name]: { ...current[name], ...patch },
    }));
    setError(null);
  };

  const handleStage = () => {
    const values: RowKey[] = [];
    for (const column of columns) {
      const field = fields[column.name] ?? { text: "", isNull: false };
      if (field.isNull) {
        if (column.nullable === false) {
          setError(`${column.name} cannot be NULL.`);
          return;
        }
        values.push({ column: column.name, value: { type: "null" } });
        continue;
      }
      if (field.text.trim().length === 0) {
        if (column.nullable === false) {
          setError(`${column.name} is required.`);
          return;
        }
        continue;
      }
      const parsed = parseColumnText(field.text, column);
      if (!parsed.ok) {
        setError(`${column.name}: ${parsed.message}`);
        return;
      }
      values.push({ column: column.name, value: parsed.value });
    }

    if (values.length === 0) {
      setError("Enter a value for at least one column.");
      return;
    }

    onStage(values);
    onClose();
  };

  return (
    <div
      data-testid="insert-row-dialog"
      role="dialog"
      aria-modal="true"
      aria-label="Insert row"
      className={cn(
        "absolute inset-0 z-10 flex items-center justify-center bg-background/70 p-4",
        className,
      )}
    >
      <div className="flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-md border border-border bg-background shadow-lg">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-[11px]">
          <div className="flex items-center gap-2">
            <span className="font-medium">New row</span>
            <span className="text-muted-foreground">
              Staged until you apply
            </span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1.5 text-[10px]"
            onClick={onClose}
            aria-label="Close insert row"
          >
            Close
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          <div className="flex flex-col gap-1">
            {columns.map((column) => {
              const field = fields[column.name] ?? { text: "", isNull: false };
              return (
                <div
                  key={column.name}
                  className="flex items-center gap-2 text-[11px]"
                >
                  <span className="w-40 shrink-0 truncate font-mono" title={column.name}>
                    {column.name}
                  </span>
                  <span className="w-16 shrink-0 truncate text-[9px] uppercase tracking-wide text-muted-foreground">
                    {column.typeName ?? "unknown"}
                  </span>
                  <input
                    aria-label={`Value for ${column.name}`}
                    value={field.isNull ? "" : field.text}
                    disabled={field.isNull}
                    spellCheck={false}
                    onChange={(event) =>
                      updateField(column.name, { text: event.target.value })
                    }
                    className={cn(inputClass(), "flex-1")}
                    placeholder={column.nullable === false ? "required" : ""}
                  />
                  <label className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground">
                    <input
                      type="checkbox"
                      aria-label={`Set ${column.name} to NULL`}
                      checked={field.isNull}
                      onChange={(event) =>
                        updateField(column.name, { isNull: event.target.checked })
                      }
                    />
                    NULL
                  </label>
                </div>
              );
            })}
          </div>
          {error ? (
            <p role="alert" className="mt-2 text-[11px] text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-1 border-t border-border px-3 py-1.5">
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
            onClick={handleStage}
          >
            Stage insert
          </Button>
        </div>
      </div>
    </div>
  );
}
