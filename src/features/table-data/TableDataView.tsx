import { useCallback, useEffect, useMemo, useState } from "react";
import type { GridSelection, Item } from "@glideapps/glide-data-grid";

import { Button } from "../../components/ui/button";
import { cn } from "../../components/ui/cn";
import type { CellValue, FilterOperator, ObjectRef, QueryError } from "../../domain";
import { ResultGrid } from "../results/ResultGrid";
import type { ResultSet } from "../results/resultSet";
import { ValueViewer } from "../results/ValueViewer";
import {
  createTableFilter,
  describeFilter,
  FILTER_OPERATORS,
  operatorNeedsValue,
  operatorTakesList,
  sortColumnOf,
  sortDirectionOf,
} from "./filters";
import { pageRangeLabel } from "./paging";
import { useTableDataController } from "./useTableData";

export interface TableDataViewProps {
  /** Connection token the page requests target. */
  connectionId: string;
  /** Table or view to browse. */
  object: ObjectRef;
  /** Closes the view, returning to the SQL workspace. */
  onClose?: () => void;
  className?: string;
}

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

/**
 * Read-only table data browser.
 *
 * Renders one bounded page at a time with database-side paging, sorting, and
 * filtering. There is deliberately no edit affordance: the grid receives no
 * edit handlers, a read-only badge is always shown, and a table without a
 * primary key or other safe identity is called out explicitly rather than
 * implying its rows can be targeted.
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

  const [filterColumn, setFilterColumn] = useState("");
  const [filterOperator, setFilterOperator] = useState<FilterOperator>("equal");
  const [filterValue, setFilterValue] = useState("");
  const [filterNotice, setFilterNotice] = useState<string | null>(null);
  const [selectedCell, setSelectedCell] = useState<Item | null>(null);
  const [viewerCell, setViewerCell] = useState<Item | null>(null);

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

  // A different object's rows replace what a viewer or selection referred to.
  useEffect(() => {
    setSelectedCell(null);
    setViewerCell(null);
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

  const selectedValue = useMemo(
    () => (selectedCell ? cellAt(columns, rows, selectedCell) : null),
    [columns, rows, selectedCell],
  );

  const viewerValue = useMemo(
    () => (viewerCell ? cellAt(columns, rows, viewerCell) : null),
    [columns, rows, viewerCell],
  );

  const rangeLabel = pageRangeLabel(
    controller.offset,
    rows.length,
    page?.totalRows,
  );

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
            data-testid="table-data-read-only"
            className="shrink-0 rounded-sm border border-border px-1 text-[9px] uppercase tracking-wide text-muted-foreground"
          >
            Read-only
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
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

      {page && !controller.hasRowIdentity ? (
        <p
          data-testid="table-data-no-identity"
          role="status"
          className="shrink-0 border-b border-border bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground"
        >
          No primary key or safe row identifier was found for this object, so its
          rows cannot be targeted for editing. Browsing is still available.
        </p>
      ) : null}

      <p className="shrink-0 px-2 py-1 text-[10px] text-muted-foreground">
        Read-only view · {qualifiedObjectName(object)} · editing rows is not
        available.
      </p>

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
            onSelectionChange={(selection: GridSelection) =>
              setSelectedCell(selection.current?.cell ?? null)
            }
            onCellActivated={setViewerCell}
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
      </div>
    </section>
  );
}
