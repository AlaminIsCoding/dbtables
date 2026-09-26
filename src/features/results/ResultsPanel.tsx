import { useCallback, useMemo, useState } from "react";
import type { GridSelection, Item } from "@glideapps/glide-data-grid";

import { Button } from "../../components/ui/button";
import { cn } from "../../components/ui/cn";
import type { CellValue, QueryError, QueryResult } from "../../domain";
import { ResultGrid } from "./ResultGrid";
import { queryResultToResultSet } from "./resultSet";
import type { QueryOutcome } from "./queryOutcome";
import { ValueViewer } from "./ValueViewer";

export interface ResultsPanelProps {
  /** Current query outcome, including idle/running/error states. */
  outcome: QueryOutcome;
  /** Whether the current partial result can be extended with another fetch. */
  canFetchMore?: boolean;
  /** Whether an incremental fetch is currently in flight. */
  fetchingMore?: boolean;
  /** Requests the next bounded page of the current result. */
  onFetchMore?: () => void;
  className?: string;
}

function selectionLabel(cell: Item | null): string | null {
  if (!cell) {
    return null;
  }

  const [col, row] = cell;
  return `R${row + 1} · C${col + 1}`;
}

/** The normalized cell at `location`, or `null` when it is out of bounds. */
function cellAt(result: QueryResult, [col, row]: Item): CellValue | null {
  const columns = result.columns ?? [];
  const rows = result.rows ?? [];
  if (row < 0 || col < 0 || row >= rows.length || col >= columns.length) {
    return null;
  }
  return rows[row]?.[col] ?? null;
}

function columnNameAt(result: QueryResult, col: number): string {
  return result.columns?.[col]?.name ?? `Column ${col + 1}`;
}

/** One-line summary shown in the results header for every outcome. */
export function summarizeOutcome(outcome: QueryOutcome): string {
  switch (outcome.kind) {
    case "idle":
      return "No query run";
    case "running":
      return "Running…";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return `Failed · ${outcome.error.category}`;
    case "error":
      return `Error · ${outcome.error.category}`;
    case "outcome_unknown":
      return "Outcome unknown";
    case "statement": {
      const affected = outcome.result.affectedRows;
      if (affected === undefined) {
        return "Statement completed";
      }
      return `${affected} row${affected === 1 ? "" : "s"} affected`;
    }
    case "grid":
    case "partial":
    case "empty": {
      const result = outcome.result;
      const rows = result.rows?.length ?? 0;
      const columns = result.columns?.length ?? 0;
      const parts = [`${rows} rows`, `${columns} columns`];
      if (outcome.kind === "partial" || result.truncated) {
        parts.push("partial");
      }
      if (result.durationMs !== undefined) {
        parts.push(`${result.durationMs} ms`);
      }
      return parts.join(" · ");
    }
  }
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

function IdleState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center">
      <p className="text-sm font-medium">No results yet</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        Open a SQLite database and run a query to see results here.
      </p>
    </div>
  );
}

function EmptyState({ columns }: { columns: number }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center">
      <p className="text-sm font-medium">Query returned no rows</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        {columns > 0
          ? `The result has ${columns} column${columns === 1 ? "" : "s"} but no rows.`
          : "The statement completed without returning rows."}
      </p>
    </div>
  );
}

function StatementState({ result }: { result: QueryResult }) {
  const affected = result.affectedRows;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center">
      <p className="text-sm font-medium">Statement completed</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        {affected === undefined
          ? "The statement completed successfully."
          : `${affected} row${affected === 1 ? "" : "s"} affected.`}
      </p>
    </div>
  );
}

function ErrorState({ error, title }: { error: QueryError; title: string }) {
  return (
    <div
      role="alert"
      className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center"
    >
      <p className="text-sm font-medium text-destructive">{title}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{error.message}</p>
      {error.engineDetail && (
        <p className="max-w-sm font-mono text-[10px] text-muted-foreground/80">
          {error.engineDetail}
        </p>
      )}
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {error.category}
      </p>
    </div>
  );
}

function CancelledState() {
  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center"
    >
      <p className="text-sm font-medium">Query cancelled</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        The operation stopped before completion. Cancellation is not proof that a
        server-side write was rolled back.
      </p>
    </div>
  );
}

function UncertainState({ error }: { error?: QueryError }) {
  return (
    <div
      role="alert"
      className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center"
    >
      <p className="text-sm font-medium text-destructive">Outcome unknown</p>
      <p className="max-w-sm text-xs text-muted-foreground">
        {error?.message ??
          "The connection was lost before the write outcome could be confirmed."}
      </p>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {error?.category ?? "transport"}
      </p>
    </div>
  );
}

function PartialBanner({
  rows,
  canFetchMore,
  fetchingMore,
  onFetchMore,
}: {
  rows: number;
  canFetchMore: boolean;
  fetchingMore: boolean;
  onFetchMore?: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
      <span role="status" data-testid="partial-notice">
        Showing first {rows} row{rows === 1 ? "" : "s"} · result is partial
      </span>
      {onFetchMore ? (
        <Button
          size="sm"
          variant="outline"
          className="h-5 px-1.5 text-[10px]"
          onClick={onFetchMore}
          disabled={!canFetchMore || fetchingMore}
        >
          {fetchingMore ? "Fetching…" : "Fetch more"}
        </Button>
      ) : null}
    </div>
  );
}

interface BodyHandlers {
  onSelectionChange: (selection: GridSelection) => void;
  onCellActivated: (location: Item) => void;
  canFetchMore: boolean;
  fetchingMore: boolean;
  onFetchMore?: () => void;
}

function renderBody(outcome: QueryOutcome, handlers: BodyHandlers) {
  switch (outcome.kind) {
    case "idle":
      return <IdleState />;
    case "running":
      return <LoadingState />;
    case "grid":
      return (
        <ResultGrid
          result={queryResultToResultSet(outcome.result)}
          onSelectionChange={handlers.onSelectionChange}
          onCellActivated={handlers.onCellActivated}
        />
      );
    case "partial":
      return (
        <div className="flex h-full min-h-0 flex-col">
          <PartialBanner
            rows={outcome.result.rows?.length ?? 0}
            canFetchMore={handlers.canFetchMore}
            fetchingMore={handlers.fetchingMore}
            onFetchMore={handlers.onFetchMore}
          />
          <div className="min-h-0 flex-1">
            <ResultGrid
              result={queryResultToResultSet(outcome.result)}
              onSelectionChange={handlers.onSelectionChange}
              onCellActivated={handlers.onCellActivated}
            />
          </div>
        </div>
      );
    case "empty":
      return <EmptyState columns={outcome.result.columns?.length ?? 0} />;
    case "statement":
      return <StatementState result={outcome.result} />;
    case "failed":
      return <ErrorState error={outcome.error} title="Query failed" />;
    case "error":
      return <ErrorState error={outcome.error} title="Backend error" />;
    case "cancelled":
      return <CancelledState />;
    case "outcome_unknown":
      return <UncertainState error={outcome.error} />;
  }
}

/**
 * Results pane for a real query run.
 *
 * Renders each normalized outcome distinctly: idle, running, grid, partial,
 * empty, statement-only, failed, command error, cancelled, and uncertain. A
 * partial result keeps its grid visible and offers a bounded "fetch more"
 * action; the full cell value viewer opens for a selected or activated cell.
 * The grid is read-only here; this slice exposes no table editing.
 */
export function ResultsPanel({
  outcome,
  canFetchMore = false,
  fetchingMore = false,
  onFetchMore,
  className,
}: ResultsPanelProps) {
  const [selectedCell, setSelectedCell] = useState<Item | null>(null);
  const [viewerCell, setViewerCell] = useState<Item | null>(null);

  const handleSelectionChange = useCallback((selection: GridSelection) => {
    setSelectedCell(selection.current?.cell ?? null);
  }, []);

  const openViewer = useCallback((location: Item) => {
    setViewerCell(location);
  }, []);

  const resultForViewer =
    outcome.kind === "grid" || outcome.kind === "partial"
      ? outcome.result
      : null;

  const selectedValue = useMemo(
    () =>
      resultForViewer && selectedCell
        ? cellAt(resultForViewer, selectedCell)
        : null,
    [resultForViewer, selectedCell],
  );

  const viewerValue = useMemo(
    () =>
      resultForViewer && viewerCell ? cellAt(resultForViewer, viewerCell) : null,
    [resultForViewer, viewerCell],
  );

  const selectedLabel = selectionLabel(selectedCell);

  return (
    <div className={cn("relative flex h-full min-h-0 flex-col", className)}>
      <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-b border-border px-2 text-[11px] text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0">Results</span>
          <span className="truncate" data-testid="results-summary" role="status">
            {summarizeOutcome(outcome)}
          </span>
          {resultForViewer && selectedLabel && (
            <span className="shrink-0">{selectedLabel}</span>
          )}
        </div>
        {selectedCell !== null && selectedValue !== null && (
          <Button
            size="sm"
            variant="ghost"
            className="h-5 shrink-0 px-1.5 text-[10px]"
            onClick={() => openViewer(selectedCell)}
          >
            View value
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {renderBody(outcome, {
          onSelectionChange: handleSelectionChange,
          onCellActivated: openViewer,
          canFetchMore,
          fetchingMore,
          onFetchMore,
        })}
      </div>

      {viewerCell && viewerValue !== null && resultForViewer && (
        <ValueViewer
          value={viewerValue}
          columnName={columnNameAt(resultForViewer, viewerCell[0])}
          rowNumber={viewerCell[1] + 1}
          onClose={() => setViewerCell(null)}
        />
      )}
    </div>
  );
}
