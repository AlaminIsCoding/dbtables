import { useCallback, useEffect, useMemo, useState } from "react";
import type { GridCell, GridSelection, Item, Theme } from "@glideapps/glide-data-grid";

import { Button } from "../../components/ui/button";
import { cn } from "../../components/ui/cn";
import type { CellValue, FilterOperator, ObjectRef, QueryError } from "../../domain";
import { ResultGrid } from "../results/ResultGrid";
import type { ResultSet } from "../results/resultSet";
import { ValueViewer } from "../results/ValueViewer";
import { isEditableValue } from "./editorValue";
import {
  createTableFilter,
  describeFilter,
  FILTER_OPERATORS,
  operatorNeedsValue,
  operatorTakesList,
  sortColumnOf,
  sortDirectionOf,
} from "./filters";
import { InsertRowDialog } from "./InsertRowDialog";
import { pageRangeLabel } from "./paging";
import {
  describeStagedChange,
  stagedDeletedRows,
  stagedEditedCells,
  type StagedChangeStatus,
} from "./stagedChanges";
import { useStagedChanges } from "./useStagedChanges";
import { useTableDataController } from "./useTableData";
import { ValueEditor } from "./ValueEditor";

export interface TableDataViewProps {
  /** Connection token the page requests target. */
  connectionId: string;
  /** Table or view to browse. */
  object: ObjectRef;
  /** Closes the view, returning to the SQL workspace. */
  onClose?: () => void;
  className?: string;
}

/** Pending-edit colours kept subtle so they do not hide the underlying value. */
const EDITED_CELL_THEME: Partial<Theme> = { bgCell: "#2563eb1f" };
const DELETED_ROW_THEME: Partial<Theme> = { bgCell: "#dc26261f", textDark: "#b91c1c" };

const STATUS_LABELS: Record<StagedChangeStatus, string> = {
  pending: "Pending",
  applying: "Applying…",
  applied: "Applied",
  failed: "Failed",
  conflict: "Conflict",
  outcome_unknown: "Outcome unknown",
};

function qualifiedObjectName(object: ObjectRef): string {
  const parts = [object.database, object.schema, object.name].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.join(".");
}

function cellAt(
  columns: ResultSet["columns"],
  rows: ResultSet["rows"],
  [col, row]: Item,
): CellValue | null {
  if (row < 0 || col < 0 || row >= rows.length || col >= columns.length) {
    return null;
  }
  return rows[row]?.[col] ?? null;
}

/** Applies a theme override without discarding an existing cell override. */
function withTheme(cell: GridCell, override: Partial<Theme>): GridCell {
  return { ...cell, themeOverride: { ...cell.themeOverride, ...override } };
}

function selectClass(): string {
  return "h-6 min-w-0 rounded-sm border border-input bg-background px-1 text-[11px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
}

function LoadingState() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-full items-center justify-center text-xs text-muted-foreground"
    >
      Loading rows…
    </div>
  );
}

function EmptyState({ filtered }: { filtered: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 p-4 text-center">
      <p className="text-sm font-medium">No rows</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        {filtered
          ? "No rows match the active filters."
          : "This table or view has no rows."}
      </p>
    </div>
  );
}

function ErrorState({ error, onRetry }: { error: QueryError; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center"
    >
      <p className="text-sm font-medium text-destructive">Could not load rows</p>
      <p className="max-w-sm text-xs text-muted-foreground">{error.message}</p>
      {error.engineDetail ? (
        <p className="max-w-sm font-mono text-[10px] text-muted-foreground/80">
          {error.engineDetail}
        </p>
      ) : null}
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {error.category}
      </p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

interface ConfirmState {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
}

function ConfirmDialog({ state, onClose }: { state: ConfirmState; onClose: () => void }) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      data-testid="confirm-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={state.title}
      className="absolute inset-0 z-20 flex items-center justify-center bg-background/70 p-4"
    >
      <div className="flex w-full max-w-md flex-col overflow-hidden rounded-md border border-border bg-background shadow-lg">
        <div className="border-b border-border px-3 py-1.5 text-[11px] font-medium">
          {state.title}
        </div>
        <p className="px-3 py-3 text-xs text-muted-foreground">{state.message}</p>
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
            variant="destructive"
            className="h-6 px-2 text-[10px]"
            onClick={() => {
              state.onConfirm();
              onClose();
            }}
          >
            {state.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Table data browser with guarded staged editing.
 *
 * Rows stay read-only until the backend reports a safe row identity and the
 * object is a base table. Edits are staged against that identity and shown in
 * the pending list and grid until an explicit apply. A conflict or unconfirmed
 * write is surfaced distinctly and never retried automatically, and the staged
 * edits survive a failed apply so they can be inspected or discarded.
 */
export function TableDataView({
  connectionId,
  object,
  onClose,
  className,
}: TableDataViewProps) {
  const controller = useTableDataController({ connectionId, object });
  const {
    columns,
    rows,
    page,
    isLoading,
    error,
    filters,
    sort,
    pageSize,
  } = controller;

  const rowIdentityColumns = page?.rowIdentity ?? [];
  const canEdit = object.kind === "table" && controller.hasRowIdentity;

  const [filterColumn, setFilterColumn] = useState("");
  const [filterOperator, setFilterOperator] = useState<FilterOperator>("equal");
  const [filterValue, setFilterValue] = useState("");
  const [filterNotice, setFilterNotice] = useState<string | null>(null);
  const [selectedCell, setSelectedCell] = useState<Item | null>(null);
  const [viewerCell, setViewerCell] = useState<Item | null>(null);
  const [editorCell, setEditorCell] = useState<Item | null>(null);
  const [insertOpen, setInsertOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const staged = useStagedChanges({
    connectionId,
    object,
    columns,
    rows,
    rowIdentityColumns,
    canEdit,
    onApplied: controller.refresh,
  });

  // Keep the selected filter column valid as columns arrive for a new object.
  useEffect(() => {
    if (columns.length === 0) {
      setFilterColumn("");
      return;
    }
    if (!columns.some((column) => column.name === filterColumn)) {
      setFilterColumn(columns[0].name);
    }
  }, [columns, filterColumn]);

  // A different object's rows replace what a viewer, editor, or selection referred to.
  useEffect(() => {
    setSelectedCell(null);
    setViewerCell(null);
    setEditorCell(null);
    setInsertOpen(false);
    setConfirm(null);
    setFilterValue("");
    setFilterNotice(null);
  }, [connectionId, object.name, object.database, object.schema, object.kind]);

  const resultSet: ResultSet = useMemo(
    () => ({
      columns,
      rows,
      truncated: page?.truncated ?? false,
    }),
    [columns, rows, page?.truncated],
  );

  const activeSortColumn = sortColumnOf(sort) ?? "";
  const activeSortDirection = sortDirectionOf(sort);

  const editedCells = useMemo(() => stagedEditedCells(staged.staged), [staged.staged]);
  const deletedRows = useMemo(() => stagedDeletedRows(staged.staged), [staged.staged]);

  const decorateCell = useCallback(
    (cell: Item, _value: CellValue, gridCell: GridCell): GridCell => {
      const [col, row] = cell;
      if (deletedRows.has(row)) {
        return withTheme(gridCell, DELETED_ROW_THEME);
      }
      const columnName = columns[col]?.name;
      if (columnName && editedCells.get(row)?.has(columnName)) {
        return withTheme(gridCell, EDITED_CELL_THEME);
      }
      return gridCell;
    },
    [columns, deletedRows, editedCells],
  );

  const handleAddFilter = useCallback(() => {
    const column = columns.find((candidate) => candidate.name === filterColumn);
    if (!column) {
      setFilterNotice("Choose a column to filter on.");
      return;
    }

    const filter = createTableFilter(column, filterOperator, filterValue);
    if (filter === null) {
      setFilterNotice("Enter a value for the selected filter.");
      return;
    }

    controller.addFilter(filter);
    setFilterValue("");
    setFilterNotice(null);
  }, [columns, controller, filterColumn, filterOperator, filterValue]);

  const handleSortColumn = useCallback(
    (column: string) => {
      if (column.length === 0) {
        controller.clearSort();
        return;
      }
      controller.applySort(column, activeSortDirection);
    },
    [activeSortDirection, controller],
  );

  const handleSortDirection = useCallback(
    (direction: "ascending" | "descending") => {
      if (activeSortColumn.length === 0) {
        return;
      }
      controller.applySort(activeSortColumn, direction);
    },
    [activeSortColumn, controller],
  );

  const handleCellActivated = useCallback(
    (cell: Item) => {
      const value = cellAt(columns, rows, cell);
      if (value === null) {
        return;
      }
      if (!canEdit || !isEditableValue(value)) {
        setViewerCell(cell);
        return;
      }
      setEditorCell(cell);
    },
    [canEdit, columns, rows],
  );

  const handleStageEdit = useCallback(
    (value: CellValue) => {
      if (!editorCell) {
        return;
      }
      const [col, row] = editorCell;
      staged.stageEdit(row, col, value);
    },
    [editorCell, staged],
  );

  const handleDeleteRow = useCallback(() => {
    const row = selectedCell?.[1];
    if (row === undefined || !canEdit) {
      return;
    }
    setConfirm({
      title: "Delete row",
      message: `Stage a delete for row ${row + 1} in ${qualifiedObjectName(object)}? The row is only removed after you apply the staged changes.`,
      confirmLabel: "Stage delete",
      onConfirm: () => staged.deleteRow(row),
    });
  }, [canEdit, object, selectedCell, staged]);

  const handleApply = useCallback(() => {
    if (staged.summary.hasDeletes) {
      setConfirm({
        title: "Apply changes",
        message: `Apply ${staged.summary.applyable} change(s), including deletes, to ${qualifiedObjectName(object)}? This cannot be undone after the database confirms it.`,
        confirmLabel: "Apply changes",
        onConfirm: () => {
          void staged.apply();
        },
      });
      return;
    }
    void staged.apply();
  }, [object, staged]);

  const handleDiscard = useCallback(() => {
    if (staged.staged.length === 0) {
      return;
    }
    setConfirm({
      title: "Discard staged changes",
      message: `Discard ${staged.staged.length} staged change(s)? Nothing has been written to the database.`,
      confirmLabel: "Discard changes",
      onConfirm: () => staged.discardAll(),
    });
  }, [staged]);

  const selectedValue = useMemo(
    () => (selectedCell ? cellAt(columns, rows, selectedCell) : null),
    [columns, rows, selectedCell],
  );

  const viewerValue = useMemo(
    () => (viewerCell ? cellAt(columns, rows, viewerCell) : null),
    [columns, rows, viewerCell],
  );

  const editorValue = useMemo(
    () => (editorCell ? cellAt(columns, rows, editorCell) : null),
    [columns, rows, editorCell],
  );

  const rangeLabel = pageRangeLabel(
    controller.offset,
    rows.length,
    page?.totalRows,
  );

  const hasConflicts = staged.summary.conflict > 0;
  const hasUncertain = staged.summary.outcomeUnknown > 0;
  const applyDisabled =
    !canEdit ||
    staged.isApplying ||
    staged.summary.applyable === 0 ||
    staged.summary.hasBlocking;

  return (
    <section
      aria-label="Table data"
      className={cn("flex min-h-0 flex-1 flex-col bg-background", className)}
    >
      <header className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-2 text-[11px]">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-semibold uppercase tracking-wide text-muted-foreground">
            Table data
          </span>
          <span className="truncate font-mono" title={qualifiedObjectName(object)}>
            {qualifiedObjectName(object)}
          </span>
          <span
            data-testid="table-data-mode"
            className={cn(
              "shrink-0 rounded-sm border px-1 text-[9px] uppercase tracking-wide",
              canEdit
                ? "border-emerald-600/40 text-emerald-700"
                : "border-border text-muted-foreground",
            )}
          >
            {canEdit ? "Editable" : "Read-only"}
          </span>
          {staged.staged.length > 0 ? (
            <span data-testid="staged-summary" className="shrink-0 text-muted-foreground">
              {staged.summary.pending + staged.summary.failed} staged
              {staged.summary.conflict > 0
                ? ` · ${staged.summary.conflict} conflict`
                : ""}
              {staged.summary.outcomeUnknown > 0
                ? ` · ${staged.summary.outcomeUnknown} uncertain`
                : ""}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canEdit ? (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-5 px-1.5 text-[10px]"
                onClick={() => setInsertOpen(true)}
                disabled={isLoading || columns.length === 0}
              >
                Add row
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-5 px-1.5 text-[10px]"
                onClick={handleDeleteRow}
                disabled={!canEdit || selectedCell === null || isLoading}
              >
                Delete row
              </Button>
              <Button
                size="sm"
                className="h-5 px-1.5 text-[10px]"
                onClick={handleApply}
                disabled={applyDisabled}
                title={
                  staged.summary.hasBlocking
                    ? "Resolve conflicted or uncertain changes before applying."
                    : undefined
                }
              >
                {staged.isApplying
                  ? "Applying…"
                  : `Apply (${staged.summary.applyable})`}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-5 px-1.5 text-[10px]"
                onClick={handleDiscard}
                disabled={staged.staged.length === 0 || staged.isApplying}
              >
                Discard
              </Button>
            </>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1.5 text-[10px]"
            onClick={controller.refresh}
            disabled={isLoading}
          >
            Refresh
          </Button>
          {onClose ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-5 px-1.5 text-[10px]"
              onClick={onClose}
              aria-label="Close table data"
            >
              Close
            </Button>
          ) : null}
        </div>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-2 py-1 text-[11px]">
        <label className="flex items-center gap-1 text-muted-foreground">
          <span>Page size</span>
          <select
            aria-label="Page size"
            className={selectClass()}
            value={pageSize}
            onChange={(event) => controller.setPageSize(Number(event.target.value))}
          >
            {[25, 50, 100].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-center gap-1">
          <select
            aria-label="Filter column"
            className={selectClass()}
            value={filterColumn}
            onChange={(event) => setFilterColumn(event.target.value)}
            disabled={columns.length === 0}
          >
            {columns.length === 0 ? <option value="">—</option> : null}
            {columns.map((column) => (
              <option key={column.name} value={column.name}>
                {column.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter operator"
            className={selectClass()}
            value={filterOperator}
            onChange={(event) =>
              setFilterOperator(event.target.value as FilterOperator)
            }
          >
            {FILTER_OPERATORS.map((option) => (
              <option key={option.operator} value={option.operator}>
                {option.label}
              </option>
            ))}
          </select>
          {operatorNeedsValue(filterOperator) ? (
            <input
              aria-label="Filter value"
              value={filterValue}
              onChange={(event) => {
                setFilterValue(event.target.value);
                setFilterNotice(null);
              }}
              placeholder={operatorTakesList(filterOperator) ? "a, b, c" : "value"}
              spellCheck={false}
              className={cn(selectClass(), "w-28")}
            />
          ) : null}
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-1.5 text-[10px]"
            onClick={handleAddFilter}
            disabled={columns.length === 0}
          >
            Add filter
          </Button>
        </div>

        <div className="flex items-center gap-1">
          <label className="flex items-center gap-1 text-muted-foreground">
            <span>Sort</span>
            <select
              aria-label="Sort column"
              className={selectClass()}
              value={activeSortColumn}
              onChange={(event) => handleSortColumn(event.target.value)}
              disabled={columns.length === 0}
            >
              <option value="">Unsorted</option>
              {columns.map((column) => (
                <option key={column.name} value={column.name}>
                  {column.name}
                </option>
              ))}
            </select>
          </label>
          <select
            aria-label="Sort direction"
            className={selectClass()}
            value={activeSortDirection}
            onChange={(event) =>
              handleSortDirection(event.target.value as "ascending" | "descending")
            }
            disabled={activeSortColumn.length === 0}
          >
            <option value="ascending">Ascending</option>
            <option value="descending">Descending</option>
          </select>
        </div>
      </div>

      {filters.length > 0 || filterNotice ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1 text-[10px]">
          <span className="text-muted-foreground">Filters:</span>
          {filters.map((filter, index) => (
            <span
              key={`${filter.column}-${filter.operator}-${index}`}
              className="inline-flex items-center gap-1 rounded-sm border border-border px-1"
            >
              <span className="font-mono">{describeFilter(filter)}</span>
              <button
                type="button"
                aria-label={`Remove filter ${index + 1}`}
                onClick={() => controller.removeFilter(index)}
                className="text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            </span>
          ))}
          {filters.length > 0 ? (
            <button
              type="button"
              className="text-muted-foreground underline hover:text-foreground"
              onClick={controller.clearFilters}
            >
              Clear
            </button>
          ) : null}
          {filterNotice ? (
            <span role="alert" className="text-destructive">
              {filterNotice}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-b border-border px-2 text-[11px] text-muted-foreground">
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            className="h-5 px-1.5 text-[10px]"
            onClick={controller.goBack}
            disabled={!controller.canGoBack || isLoading}
          >
            Prev
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-5 px-1.5 text-[10px]"
            onClick={controller.goNext}
            disabled={!controller.canGoNext || isLoading}
          >
            Next
          </Button>
        </div>
        <div className="flex items-center gap-2">
          {selectedValue !== null && selectedCell ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-5 px-1.5 text-[10px]"
              onClick={() => setViewerCell(selectedCell)}
            >
              View value
            </Button>
          ) : null}
          <span data-testid="table-data-range" role="status">
            {rangeLabel}
          </span>
        </div>
      </div>

      {page && object.kind === "table" && !controller.hasRowIdentity ? (
        <p
          data-testid="table-data-no-identity"
          role="status"
          className="shrink-0 border-b border-border bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground"
        >
          No primary key or safe row identifier was found for this object, so its
          rows cannot be targeted for editing. Browsing is still available.
        </p>
      ) : null}

      {object.kind === "view" ? (
        <p
          data-testid="table-data-view"
          role="status"
          className="shrink-0 border-b border-border bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground"
        >
          Views are read-only; rows cannot be inserted, updated, or deleted.
        </p>
      ) : null}

      {staged.staged.length > 0 || staged.applyError || staged.lastGroup ? (
        <div
          data-testid="pending-changes"
          className="shrink-0 border-b border-border bg-muted/20 px-2 py-1 text-[10px]"
        >
          {staged.staged.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {staged.staged.map((change) => (
                <li
                  key={change.id}
                  data-testid={`staged-change-${change.id}`}
                  className="flex flex-wrap items-center gap-2"
                >
                  <span
                    data-testid={`staged-status-${change.id}`}
                    className={cn(
                      "rounded-sm border px-1 uppercase tracking-wide",
                      change.status === "conflict" || change.status === "outcome_unknown"
                        ? "border-destructive/50 text-destructive"
                        : change.status === "failed"
                          ? "border-amber-600/50 text-amber-700"
                          : change.status === "applied"
                            ? "border-emerald-600/50 text-emerald-700"
                            : "border-border text-muted-foreground",
                    )}
                  >
                    {STATUS_LABELS[change.status]}
                  </span>
                  <span>{describeStagedChange(change)}</span>
                  {change.conflictedColumns.length > 0 ? (
                    <span className="text-destructive">
                      changed on server: {change.conflictedColumns.join(", ")}
                    </span>
                  ) : null}
                  {change.error ? (
                    <span className="text-destructive">{change.error.message}</span>
                  ) : null}
                  <button
                    type="button"
                    aria-label={`Discard staged change ${change.id}`}
                    onClick={() => staged.remove(change.id)}
                    className="text-muted-foreground underline hover:text-foreground"
                  >
                    Discard
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {staged.applyError ? (
            <p data-testid="apply-error" role="alert" className="mt-1 text-destructive">
              {staged.applyError.message}
            </p>
          ) : null}

          {staged.lastGroup ? (
            <p data-testid="apply-feedback" role="status" className="mt-1">
              {staged.lastGroup.state === "applied"
                ? "Changes applied and committed."
                : staged.lastGroup.state === "auto_commit"
                  ? "Changes applied (this engine has no transaction grouping)."
                  : staged.lastGroup.state === "conflict"
                    ? "A change conflicted; the batch was rolled back. Nothing was overwritten."
                    : staged.lastGroup.state === "failed"
                      ? "A change failed; the batch was rolled back."
                      : "A write outcome could not be confirmed. Do not retry automatically."}
              {staged.lastGroup.transaction ? ` (transaction ${staged.lastGroup.transaction})` : ""}
              {staged.lastGroup.error ? ` — ${staged.lastGroup.error.message}` : ""}
            </p>
          ) : null}

          {hasConflicts || hasUncertain || staged.lastGroup ? (
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {hasConflicts ? (
                <span className="text-muted-foreground">
                  Conflicted edits were not applied. Reload to see the current
                  rows, then re-stage or discard the change.
                </span>
              ) : null}
              {hasUncertain ? (
                <span className="text-destructive">
                  A write may or may not have committed. Reload and verify the
                  table before making further changes.
                </span>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                className="h-5 px-1.5 text-[10px]"
                data-testid="reload-rows"
                onClick={controller.refresh}
                disabled={isLoading}
              >
                Reload rows
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {error ? (
          <ErrorState error={error} onRetry={controller.refresh} />
        ) : page === null ? (
          <LoadingState />
        ) : rows.length === 0 ? (
          <EmptyState filtered={filters.length > 0} />
        ) : (
          <ResultGrid
            result={resultSet}
            decorateCell={canEdit ? decorateCell : undefined}
            onSelectionChange={(selection: GridSelection) =>
              setSelectedCell(selection.current?.cell ?? null)
            }
            onCellActivated={handleCellActivated}
          />
        )}

        {viewerCell && viewerValue !== null ? (
          <ValueViewer
            value={viewerValue}
            columnName={columns[viewerCell[0]]?.name ?? `Column ${viewerCell[0] + 1}`}
            rowNumber={viewerCell[1] + 1}
            onClose={() => setViewerCell(null)}
          />
        ) : null}

        {editorCell && editorValue !== null && columns[editorCell[0]] ? (
          <ValueEditor
            value={editorValue}
            column={columns[editorCell[0]]}
            rowNumber={editorCell[1] + 1}
            onSave={handleStageEdit}
            onClose={() => setEditorCell(null)}
          />
        ) : null}

        {insertOpen ? (
          <InsertRowDialog
            columns={columns}
            onStage={(values) => staged.insertRow(values)}
            onClose={() => setInsertOpen(false)}
          />
        ) : null}

        {confirm ? <ConfirmDialog state={confirm} onClose={() => setConfirm(null)} /> : null}
      </div>
    </section>
  );
}
