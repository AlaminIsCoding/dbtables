import { useCallback, useState } from "react";
import type { GridSelection, Item } from "@glideapps/glide-data-grid";

import { Button } from "../../components/ui/button";
import { cn } from "../../components/ui/cn";
import type { CellValue } from "../../domain";
import { createMockResultSet } from "./mockResult";
import { ResultGrid } from "./ResultGrid";
import { isResultSetEmpty, type ResultSet } from "./resultSet";

/** Prototype-only sample states so the loading and empty views are reviewable. */
type DemoState = "sample" | "loading" | "empty";

const SAMPLE_RESULT: ResultSet = createMockResultSet();

const DEMO_STATES: readonly { value: DemoState; label: string }[] = [
  { value: "sample", label: "Sample" },
  { value: "empty", label: "Empty" },
  { value: "loading", label: "Loading" },
];

function summarize(
  state: DemoState,
  result: ResultSet,
  editedCount: number,
): string {
  if (state === "loading") {
    return "Running…";
  }
  if (state === "empty") {
    return "0 rows";
  }

  const parts = [
    `${result.rows.length} rows`,
    `${result.columns.length} columns`,
    "mock data",
  ];

  if (result.truncated) {
    parts.push("partial");
  }
  if (editedCount > 0) {
    parts.push(`${editedCount} local edit${editedCount === 1 ? "" : "s"} (not saved)`);
  }

  return parts.join(" · ");
}

function selectionLabel(selection: GridSelection): string | null {
  const cell = selection.current?.cell;
  if (!cell) {
    return null;
  }

  const [col, row] = cell;
  return `R${row + 1} · C${col + 1}`;
}

function LoadingState() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground"
    >
      <span className="text-xs">Running query…</span>
      <div
        className="h-1 w-40 overflow-hidden rounded-full bg-muted"
        aria-hidden="true"
      >
        <div className="h-full w-1/2 animate-pulse rounded-full bg-primary" />
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center">
      <p className="text-sm font-medium">Query returned no rows</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        The result set is empty. Loading and empty states are part of the grid
        prototype.
      </p>
    </div>
  );
}

/**
 * Results pane wiring the Glide prototype to a normalized result set.
 *
 * Mock rows render by default; the state controls let the loading and empty
 * views be inspected during the manual evaluation. Edits stay in React state
 * and are never persisted.
 */
export function ResultsPanel({ className }: { className?: string }) {
  const [demoState, setDemoState] = useState<DemoState>("sample");
  const [result, setResult] = useState<ResultSet>(SAMPLE_RESULT);
  const [editedCount, setEditedCount] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);

  const handleCellEdit = useCallback((location: Item, value: CellValue) => {
    const [col, row] = location;
    setResult((current) => ({
      ...current,
      rows: current.rows.map((cells, rowIndex) =>
        rowIndex === row
          ? cells.map((cell, colIndex) => (colIndex === col ? value : cell))
          : cells,
      ),
    }));
    setEditedCount((count) => count + 1);
  }, []);

  const handleCellsEdit = useCallback(
    (edits: readonly { location: Item; value: CellValue }[]) => {
      setResult((current) => {
        const nextRows = current.rows.map((cells) => [...cells]);
        for (const { location, value } of edits) {
          const [col, row] = location;
          const target = nextRows[row];
          if (target) {
            target[col] = value;
          }
        }
        return { ...current, rows: nextRows };
      });
      setEditedCount((count) => count + edits.length);
    },
    [],
  );

  const handleSelectionChange = useCallback((selection: GridSelection) => {
    setSelected(selectionLabel(selection));
  }, []);

  const showGrid = demoState === "sample" && !isResultSetEmpty(result);

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-b border-border px-2 text-[11px] text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0">Results</span>
          <span className="truncate" data-testid="results-summary">
            {summarize(demoState, result, editedCount)}
          </span>
          {selected && <span className="shrink-0">{selected}</span>}
        </div>

        <div
          role="group"
          aria-label="Sample result state"
          className="flex shrink-0 items-center gap-0.5"
        >
          {DEMO_STATES.map(({ value, label }) => (
            <Button
              key={value}
              size="sm"
              variant={demoState === value ? "secondary" : "ghost"}
              className="h-5 px-1.5 text-[10px]"
              aria-pressed={demoState === value}
              onClick={() => setDemoState(value)}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {demoState === "loading" && <LoadingState />}
        {demoState === "empty" && <EmptyState />}
        {showGrid && (
          <ResultGrid
            result={result}
            onCellEdit={handleCellEdit}
            onCellsEdit={handleCellsEdit}
            onSelectionChange={handleSelectionChange}
          />
        )}
        {demoState === "sample" && !showGrid && <EmptyState />}
      </div>
    </div>
  );
}
